#include "linux-process-observer.h"

#include <cmath>
#include <cstdint>
#include <regex>
#include <stdexcept>
#include <string>

#ifdef __linux__
#include <cerrno>
#include <cstring>
#include <fcntl.h>
#include <poll.h>
#include <sstream>
#include <sys/syscall.h>
#include <unistd.h>
#endif

namespace {

const std::regex kStartPattern(
    R"(^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) +[0-9]{1,2} [0-9]{2}:[0-9]{2}:[0-9]{2} [0-9]{4}$)");

#ifdef __linux__

std::runtime_error SystemError(const char* operation, int error) {
  return std::runtime_error(std::string(operation) + " failed: " + std::strerror(error));
}

class OwnedFd final {
 public:
  explicit OwnedFd(int fd) : fd_(fd) {}
  OwnedFd(const OwnedFd&) = delete;
  OwnedFd& operator=(const OwnedFd&) = delete;
  ~OwnedFd() {
    if (fd_ != -1) {
      // An exception is already fail-closed. Linux releases a descriptor even
      // when close reports EINTR; retrying could close a reused descriptor.
      close(fd_);
    }
  }
  int Get() const { return fd_; }
  void Close() {
    const int fd = fd_;
    fd_ = -1;
    if (close(fd) == -1) {
      throw SystemError("close", errno);
    }
  }

 private:
  int fd_;
};

std::string ReadProc(const std::string& path) {
  const int raw_fd = open(path.c_str(), O_RDONLY | O_CLOEXEC);
  if (raw_fd == -1) {
    throw SystemError("open proc metadata", errno);
  }
  OwnedFd fd(raw_fd);
  std::string content;
  char buffer[4096];
  for (;;) {
    const ssize_t count = read(fd.Get(), buffer, sizeof(buffer));
    if (count == -1) {
      throw SystemError("read proc metadata", errno);
    }
    if (count == 0) {
      break;
    }
    content.append(buffer, static_cast<size_t>(count));
  }
  fd.Close();
  return content;
}

// Both metadata sources use the procfs instance's PID mapping. Require that
// instance to be the caller's active PID namespace, not an ancestor mount where
// an unrelated process could have the same numeric PID.
void VerifyPidMapping(const std::string& content, int expected_pid) {
  std::istringstream lines(content);
  std::string line;
  bool saw_pid = false;
  bool saw_namespace_pid = false;
  while (std::getline(lines, line)) {
    const bool is_pid = line.compare(0, 4, "Pid:") == 0;
    const bool is_namespace_pid = line.compare(0, 6, "NSpid:") == 0;
    if (!is_pid && !is_namespace_pid) {
      continue;
    }
    std::istringstream values(line.substr(is_pid ? 4 : 6));
    std::int64_t value = -1;
    std::string extra;
    if (!(values >> value) || value != expected_pid || (values >> extra)) {
      throw std::runtime_error("Linux process PID namespace or identity is ambiguous.");
    }
    bool& seen = is_pid ? saw_pid : saw_namespace_pid;
    if (seen) {
      throw std::runtime_error("Linux process PID metadata is duplicated.");
    }
    seen = true;
  }
  if (!saw_pid || !saw_namespace_pid) {
    throw std::runtime_error("Linux process PID namespace metadata is unavailable.");
  }
}

void VerifyCurrentNamespace() {
  VerifyPidMapping(ReadProc("/proc/self/status"), static_cast<int>(getpid()));
}

int OpenProcess(int pid) {
#ifdef SYS_pidfd_open
  // flags=0 observes the entire thread group. PIDFD_THREAD would incorrectly
  // retire a pthread_exit leader while a worker still owns a shared descriptor.
  return static_cast<int>(syscall(SYS_pidfd_open, pid, 0));
#else
  (void)pid;
  errno = ENOSYS;
  return -1;
#endif
}

bool GroupExited(int fd) {
  pollfd descriptor{fd, POLLIN | POLLRDNORM, 0};
  const int count = poll(&descriptor, 1, 0);
  if (count == -1) {
    throw SystemError("poll pidfd", errno);
  }
  if (count == 0 && descriptor.revents == 0) {
    return false;
  }
  const short allowed = POLLIN | POLLRDNORM | POLLHUP;
  if (count != 1 || (descriptor.revents & ~allowed) != 0 ||
      (descriptor.revents & (POLLIN | POLLHUP)) == 0) {
    throw std::runtime_error("Linux process pidfd returned an unknown poll result.");
  }
  return true;
}

Napi::Value Observe(const Napi::CallbackInfo& info, int pid,
                    const std::string& expected_start) {
  const Napi::Env env = info.Env();
  VerifyCurrentNamespace();
  const int raw_fd = OpenProcess(pid);
  if (raw_fd == -1) {
    const int error = errno;
    if (error != ESRCH) {
      throw SystemError("pidfd_open", error);
    }
    Napi::Object result = Napi::Object::New(env);
    result.Set("state", "missing");
    result.Set("pid", pid);
    return result;
  }
  OwnedFd fd(raw_fd);
  const std::string metadata_path = "/proc/self/fdinfo/" + std::to_string(fd.Get());
  // fdinfo follows the pinned struct pid, not a replacement numeric PID. A
  // fresh full read on each side rejects reaping/reuse during the start read.
  // https://github.com/torvalds/linux/blob/v6.18/fs/pidfs.c#L201
  VerifyPidMapping(ReadProc(metadata_path), pid);
  Napi::Value observed = info[2].As<Napi::Function>().Call({Napi::Number::New(env, pid)});
  VerifyCurrentNamespace();
  VerifyPidMapping(ReadProc(metadata_path), pid);
  if (!observed.IsString()) {
    throw std::runtime_error("Linux process creation time is unavailable or asynchronous.");
  }
  const std::string start = observed.As<Napi::String>().Utf8Value();
  if (!std::regex_match(start, kStartPattern) || start != expected_start) {
    throw std::runtime_error("Linux process creation time does not match expectedStart.");
  }
  // Matching strings preserve the existing second-resolution comparison only;
  // a newly opened pidfd does not strengthen a historical lease's identity.
  const bool exited = GroupExited(fd.Get());
  fd.Close();
  Napi::Object result = Napi::Object::New(env);
  result.Set("state", exited ? "exited" : "live");
  result.Set("pid", pid);
  result.Set("start", start);
  return result;
}

#endif

}  // namespace

Napi::Value ObserveLinuxProcess(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  if (info.Length() != 3 || !info[0].IsNumber() || !info[1].IsString() ||
      !info[2].IsFunction()) {
    Napi::TypeError::New(env, "observeLinuxProcess requires pid, expectedStart and a synchronous creation-time reader.")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  const double pid_value = info[0].As<Napi::Number>().DoubleValue();
  if (!std::isfinite(pid_value) || pid_value < 1 || pid_value > INT32_MAX ||
      pid_value != static_cast<std::int32_t>(pid_value)) {
    Napi::RangeError::New(env, "observeLinuxProcess pid must be a positive int32.")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  const std::string expected_start = info[1].As<Napi::String>().Utf8Value();
  if (!std::regex_match(expected_start, kStartPattern)) {
    Napi::TypeError::New(env, "observeLinuxProcess expectedStart must use the existing C/UTC lstart format.")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
#ifdef __linux__
  try {
    return Observe(info, static_cast<int>(pid_value), expected_start);
  } catch (const Napi::Error& error) {
    error.ThrowAsJavaScriptException();
  } catch (const std::exception& error) {
    Napi::Error failure = Napi::Error::New(env, error.what());
    failure.Set("code", "ERR_LINUX_PROCESS_OBSERVER");
    failure.ThrowAsJavaScriptException();
  }
#else
  Napi::Error::New(env, "Linux process observation is only available on Linux.")
      .ThrowAsJavaScriptException();
#endif
  return env.Undefined();
}
