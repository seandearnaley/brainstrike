#include <napi.h>
#include "linux-process-observer.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <exception>
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
    Drain();
    // Every path, each rejection included, releases the pinned member handles
    // here, before OnOK or OnError settles the Promise on the JS thread.
    CloseProcesses();
  }

  void OnOK() override { deferred_.Resolve(Env().Undefined()); }
  void OnError(const Napi::Error& error) override { deferred_.Reject(error.Value()); }

 private:
  void Drain() {
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

    // Windows decrements ActiveProcesses only "when the terminated process exits
    // and all references to the process are released", which can trail the exit
    // signal awaited above, and JobObjectBasicProcessIdList keeps listing such a
    // member meanwhile (BST-2137).
    // https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_accounting_information
    // Windows can release a joined member at any moment, including between the
    // reads below, so the proof only assumes that membership shrinks: under the
    // stop-admission precondition nothing can join. A census before and a census
    // after the count must each list the guard and otherwise only joined members,
    // the later one a subset of the earlier one; any other entry is a live or
    // unknown process. Releases can only lower the count, so it must lie between
    // the guard plus the members still listed afterwards and the guard plus those
    // listed before. Stop-admission is the caller's precondition, not an
    // optimistic assumption: any other entry, discrepancy or failed query rejects
    // cleanup rather than releasing the existing Root authority.
    std::vector<ULONG_PTR> listed;
    if (!ReadMembers(&listed)) {
      return;
    }
    size_t joined_listed = 0;
    if (!ListsOnlyGuardAndJoined(listed, &joined_listed)) {
      SetError(kUnproved);
      return;
    }
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
    if (!QueryInformationJobObject(job_, JobObjectBasicAccountingInformation, &accounting,
                                   sizeof(accounting), nullptr)) {
      Fail("QueryInformationJobObject", GetLastError());
      return;
    }
    std::vector<ULONG_PTR> relisted;
    if (!ReadMembers(&relisted)) {
      return;
    }
    size_t joined_relisted = 0;
    if (!ListsOnlyGuardAndJoined(relisted, &joined_relisted)) {
      SetError(kUnproved);
      return;
    }
    std::sort(listed.begin(), listed.end());
    std::sort(relisted.begin(), relisted.end());
    const size_t active = accounting.ActiveProcesses;
    if (!std::includes(listed.begin(), listed.end(), relisted.begin(), relisted.end()) ||
        active < 1 + joined_relisted || active > 1 + joined_listed) {
      SetError(kUnproved);
    }
  }

  static constexpr const char* kUnproved =
      "Windows Job Object drain did not prove the guard alone; cleanup remains unproved.";

  void Fail(const char* operation, DWORD error) { SetError(WindowsError(operation, error)); }

  // A census entry is a joined member only as one of this drain's pinned
  // processes. Each pinned handle already returned WAIT_OBJECT_0 above, so no
  // separate signal check is needed, and while the handle stays open its PID
  // cannot name another process.
  bool IsJoined(ULONG_PTR pid) const {
    for (const HANDLE process : processes_) {
      if (static_cast<ULONG_PTR>(GetProcessId(process)) == pid) {
        return true;
      }
    }
    return false;
  }

  // True when the census lists the guard and otherwise only joined members.
  bool ListsOnlyGuardAndJoined(const std::vector<ULONG_PTR>& census, size_t* joined) const {
    bool guard_listed = false;
    *joined = 0;
    for (const ULONG_PTR pid : census) {
      if (pid == guard_pid_) {
        guard_listed = true;
      } else if (IsJoined(pid)) {
        *joined += 1;
      } else {
        return false;
      }
    }
    return guard_listed;
  }

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

std::string CreationTimeText(const FILETIME& creation) {
  const std::uint64_t value = (static_cast<std::uint64_t>(creation.dwHighDateTime) << 32) |
                              creation.dwLowDateTime;
  return std::to_string(value);
}

bool ReadCreationTime(HANDLE process, std::string* creation, std::string* error) {
  FILETIME created{}, exited{}, kernel{}, user{};
  if (!GetProcessTimes(process, &created, &exited, &kernel, &user)) {
    *error = WindowsError("GetProcessTimes", GetLastError());
    return false;
  }
  *creation = CreationTimeText(created);
  return true;
}

Napi::Value GetCurrentProcessIdentity(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  std::string creation, error;
  if (!ReadCreationTime(GetCurrentProcess(), &creation, &error)) {
    Napi::Error::New(env, error).ThrowAsJavaScriptException();
    return env.Undefined();
  }
  Napi::Object identity = Napi::Object::New(env);
  identity.Set("pid", Napi::Number::New(env, GetCurrentProcessId()));
  identity.Set("creationTime", Napi::String::New(env, creation));
  return identity;
}

Napi::Value GetProcessCreationTime(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  if (info.Length() != 1 || !info[0].IsNumber()) {
    Napi::TypeError::New(env, "Process PID must be a positive integer.")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  const double value = info[0].As<Napi::Number>().DoubleValue();
  if (!std::isfinite(value) || value <= 0 || value > UINT32_MAX || std::floor(value) != value) {
    Napi::TypeError::New(env, "Process PID must be a positive integer.")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE,
                               static_cast<DWORD>(value));
  if (process == nullptr) {
    const DWORD error = GetLastError();
    if (error == ERROR_INVALID_PARAMETER) return env.Null();
    Napi::Error::New(env, WindowsError("OpenProcess", error)).ThrowAsJavaScriptException();
    return env.Undefined();
  }
  const DWORD wait = WaitForSingleObject(process, 0);
  std::string creation, error;
  if (wait == WAIT_TIMEOUT) {
    ReadCreationTime(process, &creation, &error);
  } else if (wait != WAIT_OBJECT_0) {
    error = WindowsError("WaitForSingleObject", GetLastError());
  }
  if (!CloseHandle(process) && error.empty()) {
    error = WindowsError("CloseHandle", GetLastError());
  }
  if (!error.empty()) {
    Napi::Error::New(env, error).ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (wait == WAIT_OBJECT_0) return env.Null();
  return Napi::String::New(env, creation);
}

bool ReadCommandMembers(HANDLE job, std::vector<ULONG_PTR>* members, std::string* error) {
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
  if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, &accounting,
                                 sizeof(accounting), nullptr)) {
    *error = WindowsError("QueryInformationJobObject", GetLastError());
    return false;
  }
  DWORD capacity = accounting.ActiveProcesses + 8;
  // Only buffer resizing, as in the host Job API; never extinction polling.
  for (int attempt = 0; attempt < 4; ++attempt) {
    const size_t bytes = sizeof(JOBOBJECT_BASIC_PROCESS_ID_LIST) +
                         static_cast<size_t>(capacity - 1) * sizeof(ULONG_PTR);
    std::vector<ULONG_PTR> storage((bytes + sizeof(ULONG_PTR) - 1) / sizeof(ULONG_PTR));
    auto* list = reinterpret_cast<JOBOBJECT_BASIC_PROCESS_ID_LIST*>(storage.data());
    if (QueryInformationJobObject(job, JobObjectBasicProcessIdList, list,
                                  static_cast<DWORD>(bytes), nullptr)) {
      members->assign(list->ProcessIdList, list->ProcessIdList + list->NumberOfProcessIdsInList);
      return true;
    }
    const DWORD query_error = GetLastError();
    if (query_error != ERROR_MORE_DATA) {
      *error = WindowsError("QueryInformationJobObject", query_error);
      return false;
    }
    capacity = list->NumberOfAssignedProcesses + 8;
  }
  *error = "Private command Job membership did not stabilize during enumeration.";
  return false;
}

class CommandJob final : public Napi::ObjectWrap<CommandJob> {
 public:
  static Napi::Value Create(const Napi::CallbackInfo& info) {
    return DefineClass(info.Env(), "CommandJob", {
      InstanceMethod("assign", &CommandJob::Assign),
      InstanceMethod("terminateAndWait", &CommandJob::TerminateAndWait),
      InstanceMethod("close", &CommandJob::Close),
    }).New({});
  }

  explicit CommandJob(const Napi::CallbackInfo& info) : Napi::ObjectWrap<CommandJob>(info) {
    job_ = CreateJobObjectW(nullptr, nullptr);
    if (job_ == nullptr) {
      ThrowWindowsError(info.Env(), "CreateJobObjectW", GetLastError());
      return;
    }
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(job_, JobObjectExtendedLimitInformation, &limits,
                                 sizeof(limits))) {
      const DWORD error = GetLastError();
      CloseHandle(job_);
      job_ = nullptr;
      ThrowWindowsError(info.Env(), "SetInformationJobObject", error);
      return;
    }
    // The parent is never assigned. Keep the owner alive until explicit proved
    // close, including rejected joins. GC must not turn failure into retirement.
    Ref();
  }

  ~CommandJob() override {
    // A live owner is strongly referenced; this path is otherwise environment
    // teardown. Kill-on-close is crash containment, never a successful join.
    for (const HANDLE process : processes_) {
      if (process != nullptr) CloseHandle(process);
    }
    if (job_ != nullptr) CloseHandle(job_);
  }

 private:
  class JoinWorker final : public Napi::AsyncWorker {
   public:
    JoinWorker(Napi::Env env, CommandJob* owner, UINT exit_code,
               Napi::Promise::Deferred deferred)
        : Napi::AsyncWorker(env), owner_(owner), exit_code_(exit_code), deferred_(deferred) {}

    void Execute() override {
      BOOL parent_in_job = FALSE;
      if (!IsProcessInJob(GetCurrentProcess(), owner_->job_, &parent_in_job)) {
        Fail("IsProcessInJob", GetLastError());
        return;
      }
      if (parent_in_job) {
        SetError("Private command Job unexpectedly contains its parent; cleanup remains unproved.");
        return;
      }
      if (!PinMembers()) return;
      // The kernel terminates the entire nested Job, including racing children.
      // https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-terminatejobobject
      if (!TerminateJobObject(owner_->job_, exit_code_)) {
        Fail("TerminateJobObject", GetLastError());
        return;
      }
      // Pin any members born between the first census and the kernel kill. This
      // is a fresh Job census, not a second/global process inventory or polling.
      if (!PinMembers()) return;
      for (const HANDLE process : owner_->processes_) {
        const DWORD wait = WaitForSingleObject(process, INFINITE);
        if (wait != WAIT_OBJECT_0) {
          Fail("WaitForSingleObject", wait == WAIT_FAILED ? GetLastError() : wait);
          return;
        }
      }
      std::vector<ULONG_PTR> members;
      std::string error;
      if (!ReadCommandMembers(owner_->job_, &members, &error)) {
        SetError(error);
        return;
      }
      JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
      if (!QueryInformationJobObject(owner_->job_, JobObjectBasicAccountingInformation,
                                     &accounting, sizeof(accounting), nullptr)) {
        Fail("QueryInformationJobObject", GetLastError());
        return;
      }
      if (!members.empty() || accounting.ActiveProcesses != 0) {
        SetError("Private command Job did not prove zero members; cleanup remains unproved.");
      }
    }

    void OnOK() override {
      owner_->empty_proved_ = true;
      deferred_.Resolve(Env().Undefined());
    }
    void OnError(const Napi::Error& error) override { deferred_.Reject(error.Value()); }

   private:
    void Fail(const char* operation, DWORD error) { SetError(WindowsError(operation, error)); }
    bool PinMembers() {
      std::vector<ULONG_PTR> members;
      std::string error;
      if (!ReadCommandMembers(owner_->job_, &members, &error)) {
        SetError(error);
        return false;
      }
      for (const ULONG_PTR raw_pid : members) {
        HANDLE process = OpenProcess(
            PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE,
            FALSE, static_cast<DWORD>(raw_pid));
        if (process == nullptr) {
          const DWORD open_error = GetLastError();
          // An absent PID alone proves nothing. The final fresh zero proof must
          // cover the original member; every successfully pinned object joins.
          if (open_error == ERROR_INVALID_PARAMETER) continue;
          Fail("OpenProcess", open_error);
          return false;
        }
        BOOL contained = FALSE;
        if (!IsProcessInJob(process, owner_->job_, &contained)) {
          const DWORD query_error = GetLastError();
          owner_->processes_.push_back(process);
          Fail("IsProcessInJob", query_error);
          return false;
        }
        if (!contained) {
          // The census PID was reused outside this Job. Do not terminate it.
          CloseHandle(process);
          continue;
        }
        owner_->processes_.push_back(process);
      }
      return true;
    }
    CommandJob* owner_;
    UINT exit_code_;
    Napi::Promise::Deferred deferred_;
  };

  Napi::Value Assign(const Napi::CallbackInfo& info) {
    const Napi::Env env = info.Env();
    if (job_ == nullptr || !join_.IsEmpty()) {
      Napi::Error::New(env, "Private command Job admissions are closed.").ThrowAsJavaScriptException();
      return env.Undefined();
    }
    if (info.Length() != 1 || !info[0].IsObject()) {
      Napi::TypeError::New(env, "assign requires one process identity.").ThrowAsJavaScriptException();
      return env.Undefined();
    }
    const Napi::Object identity = info[0].As<Napi::Object>();
    const Napi::Value pid_value = identity.Get("pid");
    const Napi::Value creation_value = identity.Get("creationTime");
    if (!pid_value.IsNumber() || !creation_value.IsString()) {
      Napi::TypeError::New(env, "Process identity requires numeric pid and string creationTime.")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }
    const double raw_pid = pid_value.As<Napi::Number>().DoubleValue();
    if (!std::isfinite(raw_pid) || raw_pid <= 0 || raw_pid > UINT32_MAX ||
        raw_pid != static_cast<DWORD>(raw_pid)) {
      Napi::RangeError::New(env, "Process identity pid must be a positive uint32.")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }
    const DWORD pid = static_cast<DWORD>(raw_pid);
    if (pid == GetCurrentProcessId()) {
      Napi::Error::New(env, "Private command Job cannot contain its parent.").ThrowAsJavaScriptException();
      return env.Undefined();
    }
    HANDLE process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE |
                                 PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid);
    if (process == nullptr) {
      ThrowWindowsError(env, "OpenProcess", GetLastError());
      return env.Undefined();
    }
    std::string creation, error;
    if (!ReadCreationTime(process, &creation, &error)) {
      CloseHandle(process);
      Napi::Error::New(env, error).ThrowAsJavaScriptException();
      return env.Undefined();
    }
    if (creation != creation_value.As<Napi::String>().Utf8Value()) {
      CloseHandle(process);
      Napi::Error::New(env, "Process creation identity does not match; no process was assigned.")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }
    const DWORD wait = WaitForSingleObject(process, 0);
    if (wait != WAIT_TIMEOUT) {
      const DWORD wait_error = wait == WAIT_FAILED ? GetLastError() : wait;
      CloseHandle(process);
      Napi::Error::New(env, wait == WAIT_OBJECT_0 ? "Process already exited before assignment." :
                      WindowsError("WaitForSingleObject", wait_error)).ThrowAsJavaScriptException();
      return env.Undefined();
    }
    // The opened handle pins the identity from the wrapper's private READY IPC.
    // Never replace that claim with a fresh PID-only observation after spawn.
    if (!AssignProcessToJobObject(job_, process)) {
      const DWORD assign_error = GetLastError();
      CloseHandle(process);
      ThrowWindowsError(env, "AssignProcessToJobObject", assign_error);
      return env.Undefined();
    }
    assigned_ = true;
    processes_.push_back(process);
    BOOL contained = FALSE;
    if (!IsProcessInJob(process, job_, &contained)) {
      ThrowWindowsError(env, "IsProcessInJob", GetLastError());
    } else if (!contained) {
      Napi::Error::New(env, "Assigned process membership remains unproved.").ThrowAsJavaScriptException();
    }
    return env.Undefined();
  }

  Napi::Value TerminateAndWait(const Napi::CallbackInfo& info) {
    const Napi::Env env = info.Env();
    auto deferred = Napi::Promise::Deferred::New(env);
    if (info.Length() != 1 || !info[0].IsNumber()) {
      deferred.Reject(Napi::TypeError::New(env, "terminateAndWait requires one numeric exit code.").Value());
      return deferred.Promise();
    }
    const double exit_code = info[0].As<Napi::Number>().DoubleValue();
    if (!std::isfinite(exit_code) || exit_code < 0 || exit_code > UINT32_MAX ||
        exit_code != static_cast<UINT>(exit_code)) {
      deferred.Reject(Napi::RangeError::New(env, "terminateAndWait exit code must be a uint32.").Value());
      return deferred.Promise();
    }
    if (!join_.IsEmpty()) return join_.Value();
    if (job_ == nullptr) {
      deferred.Reject(Napi::Error::New(env, "Private command Job is closed.").Value());
      return deferred.Promise();
    }
    const Napi::Promise promise = deferred.Promise();
    join_ = Napi::Persistent(promise.As<Napi::Object>());
    try {
      auto worker = std::make_unique<JoinWorker>(env, this, static_cast<UINT>(exit_code), deferred);
      worker->Queue();
      worker.release();
    } catch (const Napi::Error& error) {
      deferred.Reject(error.Value());
    } catch (const std::exception& error) {
      deferred.Reject(Napi::Error::New(env, error.what()).Value());
    }
    return promise;
  }

  Napi::Value Close(const Napi::CallbackInfo& info) {
    const Napi::Env env = info.Env();
    if (job_ == nullptr) return env.Undefined();
    if (assigned_ && !empty_proved_) {
      Napi::Error::New(env, "Private command Job cleanup remains unproved; owner retained.")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }
    if (!assigned_ && !join_.IsEmpty() && !empty_proved_) {
      Napi::Error::New(env, "Private command Job join has not proved cleanup; owner retained.")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }
    if (!empty_proved_) {
      std::vector<ULONG_PTR> members;
      std::string error;
      if (!ReadCommandMembers(job_, &members, &error)) {
        Napi::Error::New(env, error).ThrowAsJavaScriptException();
        return env.Undefined();
      }
      JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
      if (!QueryInformationJobObject(job_, JobObjectBasicAccountingInformation, &accounting,
                                     sizeof(accounting), nullptr)) {
        ThrowWindowsError(env, "QueryInformationJobObject", GetLastError());
        return env.Undefined();
      }
      if (!members.empty() || accounting.ActiveProcesses != 0) {
        Napi::Error::New(env, "Private command Job is not proved empty; owner retained.")
            .ThrowAsJavaScriptException();
        return env.Undefined();
      }
    }
    for (HANDLE& process : processes_) {
      if (process == nullptr) continue;
      if (!CloseHandle(process)) {
        ThrowWindowsError(env, "CloseHandle", GetLastError());
        return env.Undefined();
      }
      process = nullptr;
    }
    if (!CloseHandle(job_)) {
      ThrowWindowsError(env, "CloseHandle", GetLastError());
      return env.Undefined();
    }
    job_ = nullptr;
    Unref();
    return env.Undefined();
  }

  HANDLE job_ = nullptr;
  bool assigned_ = false;
  bool empty_proved_ = false;
  Napi::ObjectReference join_;
  std::vector<HANDLE> processes_;
};


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
  exports.Set("observeLinuxProcess", Napi::Function::New(env, ObserveLinuxProcess));
#ifdef _WIN32
  exports.Set("createCommandJob", Napi::Function::New(env, CommandJob::Create));
  exports.Set("getCurrentProcessIdentity", Napi::Function::New(env, GetCurrentProcessIdentity));
  exports.Set("getProcessCreationTime", Napi::Function::New(env, GetProcessCreationTime));
  exports.Set("activeProcessCount", Napi::Function::New(env, ActiveProcessCount));
  exports.Set("drainOtherProcesses", Napi::Function::New(env, DrainOtherProcesses));
  exports.Set("initialize", Napi::Function::New(env, Initialize));
  exports.Set("terminateOtherProcesses", Napi::Function::New(env, TerminateOtherProcesses));
#else
  exports.Set("createCommandJob", Napi::Function::New(env, Unsupported));
  exports.Set("getCurrentProcessIdentity", Napi::Function::New(env, Unsupported));
  exports.Set("getProcessCreationTime", Napi::Function::New(env, Unsupported));
  exports.Set("activeProcessCount", Napi::Function::New(env, Unsupported));
  exports.Set("drainOtherProcesses", Napi::Function::New(env, UnsupportedDrain));
  exports.Set("initialize", Napi::Function::New(env, Unsupported));
  exports.Set("terminateOtherProcesses", Napi::Function::New(env, Unsupported));
#endif
  return exports;
}

}  // namespace

NODE_API_MODULE(windows_job_native, Init)
