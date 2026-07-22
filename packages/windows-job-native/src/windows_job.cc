#include <napi.h>

#include <cmath>
#include <cstdint>
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

#else

Napi::Value Unsupported(const Napi::CallbackInfo& info) {
  Napi::Error::New(info.Env(), "Windows Job Objects are only available on Windows.")
      .ThrowAsJavaScriptException();
  return info.Env().Undefined();
}

#endif

Napi::Object Init(Napi::Env env, Napi::Object exports) {
#ifdef _WIN32
  exports.Set("activeProcessCount", Napi::Function::New(env, ActiveProcessCount));
  exports.Set("initialize", Napi::Function::New(env, Initialize));
  exports.Set("terminateOtherProcesses", Napi::Function::New(env, TerminateOtherProcesses));
#else
  exports.Set("activeProcessCount", Napi::Function::New(env, Unsupported));
  exports.Set("initialize", Napi::Function::New(env, Unsupported));
  exports.Set("terminateOtherProcesses", Napi::Function::New(env, Unsupported));
#endif
  return exports;
}

}  // namespace

NODE_API_MODULE(windows_job_native, Init)
