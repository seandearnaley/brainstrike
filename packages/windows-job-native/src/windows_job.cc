#include <napi.h>

#include <cmath>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <Windows.h>
#endif

namespace {

#ifdef _WIN32

HANDLE job_handle = nullptr;

std::string WindowsError(const char* operation, DWORD error) {
  return std::string(operation) + " failed with Windows error " + std::to_string(error) + ".";
}

void ThrowWindowsError(const Napi::Env& env, const char* operation, DWORD error) {
  Napi::Error::New(env, WindowsError(operation, error)).ThrowAsJavaScriptException();
}

bool EnsureInitialized(const Napi::Env& env) {
  if (job_handle != nullptr) {
    return true;
  }
  Napi::Error::New(env, "Windows Job Object has not been initialized.")
      .ThrowAsJavaScriptException();
  return false;
}

Napi::Value Initialize(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  if (job_handle != nullptr) {
    return env.Undefined();
  }

  HANDLE candidate = CreateJobObjectW(nullptr, nullptr);
  if (candidate == nullptr) {
    ThrowWindowsError(env, "CreateJobObjectW", GetLastError());
    return env.Undefined();
  }

  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(candidate, JobObjectExtendedLimitInformation, &limits,
                               sizeof(limits))) {
    const DWORD error = GetLastError();
    CloseHandle(candidate);
    ThrowWindowsError(env, "SetInformationJobObject", error);
    return env.Undefined();
  }

  if (!AssignProcessToJobObject(candidate, GetCurrentProcess())) {
    const DWORD error = GetLastError();
    CloseHandle(candidate);
    ThrowWindowsError(env, "AssignProcessToJobObject", error);
    return env.Undefined();
  }

  job_handle = candidate;
  return env.Undefined();
}

Napi::Value ActiveProcessCount(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  if (!EnsureInitialized(env)) {
    return env.Undefined();
  }

  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
  if (!QueryInformationJobObject(job_handle, JobObjectBasicAccountingInformation, &accounting,
                                 sizeof(accounting), nullptr)) {
    ThrowWindowsError(env, "QueryInformationJobObject", GetLastError());
    return env.Undefined();
  }
  return Napi::Number::New(env, accounting.ActiveProcesses);
}

bool ReadProcessIds(const Napi::Env& env, std::vector<ULONG_PTR>* process_ids) {
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
  if (!QueryInformationJobObject(job_handle, JobObjectBasicAccountingInformation, &accounting,
                                 sizeof(accounting), nullptr)) {
    ThrowWindowsError(env, "QueryInformationJobObject", GetLastError());
    return false;
  }

  DWORD capacity = accounting.ActiveProcesses + 8;
  for (int attempt = 0; attempt < 4; ++attempt) {
    const size_t bytes = sizeof(JOBOBJECT_BASIC_PROCESS_ID_LIST) +
                         static_cast<size_t>(capacity - 1) * sizeof(ULONG_PTR);
    std::vector<ULONG_PTR> storage((bytes + sizeof(ULONG_PTR) - 1) / sizeof(ULONG_PTR));
    auto* list = reinterpret_cast<JOBOBJECT_BASIC_PROCESS_ID_LIST*>(storage.data());
    list->NumberOfAssignedProcesses = capacity;
    if (QueryInformationJobObject(job_handle, JobObjectBasicProcessIdList, list,
                                  static_cast<DWORD>(bytes), nullptr)) {
      process_ids->assign(list->ProcessIdList,
                          list->ProcessIdList + list->NumberOfProcessIdsInList);
      return true;
    }
    const DWORD error = GetLastError();
    if (error != ERROR_MORE_DATA) {
      ThrowWindowsError(env, "QueryInformationJobObject", error);
      return false;
    }
    capacity = list->NumberOfAssignedProcesses + 8;
  }

  Napi::Error::New(env, "Windows Job Object membership did not stabilize during enumeration.")
      .ThrowAsJavaScriptException();
  return false;
}

Napi::Value TerminateOtherProcesses(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  if (!EnsureInitialized(env)) {
    return env.Undefined();
  }
  if (info.Length() != 1 || !info[0].IsNumber()) {
    Napi::TypeError::New(env, "terminateOtherProcesses requires one numeric exit code.")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  const double exit_code_value = info[0].As<Napi::Number>().DoubleValue();
  if (!std::isfinite(exit_code_value) || exit_code_value < 0 || exit_code_value > UINT32_MAX ||
      exit_code_value != static_cast<std::uint32_t>(exit_code_value)) {
    Napi::RangeError::New(env, "terminateOtherProcesses exit code must be a uint32.")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  std::vector<ULONG_PTR> process_ids;
  if (!ReadProcessIds(env, &process_ids)) {
    return env.Undefined();
  }

  const DWORD current_pid = GetCurrentProcessId();
  std::uint32_t terminated = 0;
  for (const ULONG_PTR raw_pid : process_ids) {
    const DWORD pid = static_cast<DWORD>(raw_pid);
    if (pid == current_pid) {
      continue;
    }
    HANDLE process = OpenProcess(PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (process == nullptr) {
      const DWORD error = GetLastError();
      if (error == ERROR_INVALID_PARAMETER) {
        continue;
      }
      ThrowWindowsError(env, "OpenProcess", error);
      return env.Undefined();
    }

    BOOL is_in_job = FALSE;
    if (!IsProcessInJob(process, job_handle, &is_in_job)) {
      const DWORD error = GetLastError();
      CloseHandle(process);
      ThrowWindowsError(env, "IsProcessInJob", error);
      return env.Undefined();
    }
    if (!is_in_job) {
      CloseHandle(process);
      continue;
    }

    if (!TerminateProcess(process, static_cast<UINT>(exit_code_value))) {
      const DWORD error = GetLastError();
      DWORD observed_exit_code = STILL_ACTIVE;
      const bool already_exited =
          error == ERROR_ACCESS_DENIED && GetExitCodeProcess(process, &observed_exit_code) &&
          observed_exit_code != STILL_ACTIVE;
      CloseHandle(process);
      if (already_exited) {
        continue;
      }
      ThrowWindowsError(env, "TerminateProcess", error);
      return env.Undefined();
    }
    CloseHandle(process);
    terminated += 1;
  }
  return Napi::Number::New(env, terminated);
}

class DrainWorker final : public Napi::AsyncWorker {
 public:
  DrainWorker(Napi::Env env, HANDLE job, UINT exit_code)
      : Napi::AsyncWorker(env), deferred_(Napi::Promise::Deferred::New(env)),
        job_(job), guard_pid_(GetCurrentProcessId()), exit_code_(exit_code) {}

  ~DrainWorker() override {
    CloseProcesses();
    CloseHandle(job_);
  }

  Napi::Promise Promise() const { return deferred_.Promise(); }

  void Execute() override {
    BOOL guard_in_job = FALSE;
    if (!IsProcessInJob(GetCurrentProcess(), job_, &guard_in_job)) {
      Fail("IsProcessInJob", GetLastError());
      return;
    }
    if (!guard_in_job) {
      SetError("Windows Job Object drain caller is not a contained guard.");
      return;
    }

    std::vector<ULONG_PTR> members;
    if (!ReadMembers(&members)) {
      return;
    }
    for (const ULONG_PTR raw_pid : members) {
      const DWORD pid = static_cast<DWORD>(raw_pid);
      if (pid == guard_pid_) {
        continue;
      }
      HANDLE process = OpenProcess(
          PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid);
      if (process == nullptr) {
        const DWORD error = GetLastError();
        // A disappearing census PID is not proof. The final census/accounting
        // must still establish that no other Job member remains.
        if (error == ERROR_INVALID_PARAMETER) {
          continue;
        }
        Fail("OpenProcess", error);
        return;
      }
      processes_.push_back(process);
      BOOL contained = FALSE;
      if (!IsProcessInJob(process, job_, &contained)) {
        Fail("IsProcessInJob", GetLastError());
        return;
      }
      if (!contained) {
        // PID reuse can only select a foreign object before it is pinned.
        // Never terminate it; the final Job proof covers the original member.
        CloseHandle(process);
        processes_.pop_back();
      }
    }

    // Pin the whole census before requesting any termination. Request the whole
    // contained cohort before waiting, rather than leaving peers running while
    // one member's physical exit is pending.
    for (const HANDLE process : processes_) {
      if (!TerminateProcess(process, exit_code_)) {
        const DWORD error = GetLastError();
        // Exit code 259 (STILL_ACTIVE) can also be a real exit code. Only the
        // pinned process object's signal proves exit, including this race.
        if (error != ERROR_ACCESS_DENIED || WaitForSingleObject(process, 0) != WAIT_OBJECT_0) {
          Fail("TerminateProcess", error);
          return;
        }
      }
    }
    // TerminateProcess is asynchronous. No deadline or cancellation substitutes
    // for these physical signals. Execute runs off the JS/event-loop thread.
    // https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-terminateprocess
    for (const HANDLE process : processes_) {
      const DWORD wait = WaitForSingleObject(process, INFINITE);
      if (wait != WAIT_OBJECT_0) {
        Fail("WaitForSingleObject", wait == WAIT_FAILED ? GetLastError() : wait);
        return;
      }
    }
    CloseProcesses();

    // Stop-admission is the caller's precondition, not an optimistic assumption.
    // Any remaining membership/accounting discrepancy or failed query rejects
    // cleanup rather than releasing the existing Root authority.
    members.clear();
    if (!ReadMembers(&members)) {
      return;
    }
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
    if (!QueryInformationJobObject(job_, JobObjectBasicAccountingInformation, &accounting,
                                   sizeof(accounting), nullptr)) {
      Fail("QueryInformationJobObject", GetLastError());
      return;
    }
    if (members.size() != 1 || members.front() != guard_pid_ || accounting.ActiveProcesses != 1) {
      SetError("Windows Job Object drain did not prove the guard alone; cleanup remains unproved.");
    }
  }

  void OnOK() override { deferred_.Resolve(Env().Undefined()); }
  void OnError(const Napi::Error& error) override { deferred_.Reject(error.Value()); }

 private:
  void Fail(const char* operation, DWORD error) { SetError(WindowsError(operation, error)); }

  void CloseProcesses() {
    for (const HANDLE process : processes_) {
      CloseHandle(process);
    }
    processes_.clear();
  }

  bool ReadMembers(std::vector<ULONG_PTR>* members) {
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
    if (!QueryInformationJobObject(job_, JobObjectBasicAccountingInformation, &accounting,
                                   sizeof(accounting), nullptr)) {
      Fail("QueryInformationJobObject", GetLastError());
      return false;
    }
    DWORD capacity = accounting.ActiveProcesses + 8;
    // Match the existing API's bounded census allocation; exhausted enumeration
    // rejects and is never treated as extinction.
    for (int attempt = 0; attempt < 4; ++attempt) {
      const size_t bytes = sizeof(JOBOBJECT_BASIC_PROCESS_ID_LIST) +
                           static_cast<size_t>(capacity - 1) * sizeof(ULONG_PTR);
      std::vector<ULONG_PTR> storage((bytes + sizeof(ULONG_PTR) - 1) / sizeof(ULONG_PTR));
      auto* list = reinterpret_cast<JOBOBJECT_BASIC_PROCESS_ID_LIST*>(storage.data());
      if (QueryInformationJobObject(job_, JobObjectBasicProcessIdList, list,
                                    static_cast<DWORD>(bytes), nullptr)) {
        members->assign(list->ProcessIdList, list->ProcessIdList + list->NumberOfProcessIdsInList);
        return true;
      }
      const DWORD error = GetLastError();
      if (error != ERROR_MORE_DATA) {
        Fail("QueryInformationJobObject", error);
        return false;
      }
      capacity = list->NumberOfAssignedProcesses + 8;
    }
    SetError("Windows Job Object membership did not stabilize during enumeration.");
    return false;
  }

  Napi::Promise::Deferred deferred_;
  HANDLE job_;
  DWORD guard_pid_;
  UINT exit_code_;
  std::vector<HANDLE> processes_;
};

Napi::Value DrainOtherProcesses(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  auto rejected = Napi::Promise::Deferred::New(env);
  if (info.Length() != 1 || !info[0].IsNumber()) {
    rejected.Reject(Napi::TypeError::New(env, "drainOtherProcesses requires one numeric exit code.").Value());
    return rejected.Promise();
  }
  const double value = info[0].As<Napi::Number>().DoubleValue();
  if (!std::isfinite(value) || value < 0 || value > UINT32_MAX ||
      value != static_cast<std::uint32_t>(value)) {
    rejected.Reject(Napi::RangeError::New(env, "drainOtherProcesses exit code must be a uint32.").Value());
    return rejected.Promise();
  }
  if (job_handle == nullptr) {
    rejected.Reject(Napi::Error::New(env, "Windows Job Object has not been initialized.").Value());
    return rejected.Promise();
  }
  HANDLE pinned_job = nullptr;
  if (!DuplicateHandle(GetCurrentProcess(), job_handle, GetCurrentProcess(), &pinned_job,
                       0, FALSE, DUPLICATE_SAME_ACCESS)) {
    rejected.Reject(Napi::Error::New(env, WindowsError("DuplicateHandle", GetLastError())).Value());
    return rejected.Promise();
  }
  auto worker = std::make_unique<DrainWorker>(env, pinned_job, static_cast<UINT>(value));
  const Napi::Promise promise = worker->Promise();
  worker->Queue();
  worker.release();
  return promise;
}

#else

Napi::Value Unsupported(const Napi::CallbackInfo& info) {
  Napi::Error::New(info.Env(), "Windows Job Objects are only available on Windows.")
      .ThrowAsJavaScriptException();
  return info.Env().Undefined();
}

Napi::Value UnsupportedDrain(const Napi::CallbackInfo& info) {
  auto deferred = Napi::Promise::Deferred::New(info.Env());
  deferred.Reject(Napi::Error::New(info.Env(), "Windows Job Objects are only available on Windows.").Value());
  return deferred.Promise();
}

#endif

Napi::Object Init(Napi::Env env, Napi::Object exports) {
#ifdef _WIN32
  exports.Set("activeProcessCount", Napi::Function::New(env, ActiveProcessCount));
  exports.Set("drainOtherProcesses", Napi::Function::New(env, DrainOtherProcesses));
  exports.Set("initialize", Napi::Function::New(env, Initialize));
  exports.Set("terminateOtherProcesses", Napi::Function::New(env, TerminateOtherProcesses));
#else
  exports.Set("activeProcessCount", Napi::Function::New(env, Unsupported));
  exports.Set("drainOtherProcesses", Napi::Function::New(env, UnsupportedDrain));
  exports.Set("initialize", Napi::Function::New(env, Unsupported));
  exports.Set("terminateOtherProcesses", Napi::Function::New(env, Unsupported));
#endif
  return exports;
}

}  // namespace

NODE_API_MODULE(windows_job_native, Init)
