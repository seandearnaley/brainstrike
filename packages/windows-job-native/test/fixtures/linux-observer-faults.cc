#include <napi.h>
#include "../../src/linux-process-observer.h"

#include <algorithm>
#include <cerrno>
#include <cstdarg>
#include <fcntl.h>
#include <map>
#include <poll.h>
#include <set>
#include <string>
#include <sys/syscall.h>
#include <unistd.h>

namespace {
std::string fault;
std::set<int> owned;
std::map<int, std::string> replacement;
int pidfd = -1;
int pidfd_calls = 0;
int pidfd_flags = -1;
int poll_calls = 0;
int fdinfo_reads = 0;
int pidfd_close_attempts = 0;

Napi::Value Configure(const Napi::CallbackInfo& info) {
  if (!owned.empty()) {
    throw Napi::Error::New(info.Env(), "Previous observer leaked a descriptor.");
  }
  fault = info[0].As<Napi::String>().Utf8Value();
  pidfd = -1;
  pidfd_calls = 0;
  pidfd_flags = -1;
  poll_calls = 0;
  fdinfo_reads = 0;
  pidfd_close_attempts = 0;
  return info.Env().Undefined();
}

Napi::Value Counters(const Napi::CallbackInfo& info) {
  Napi::Object result = Napi::Object::New(info.Env());
  result.Set("owned", owned.size());
  result.Set("pidfdCalls", pidfd_calls);
  result.Set("pidfdFlags", pidfd_flags);
  result.Set("pollCalls", poll_calls);
  result.Set("pidfdCloseAttempts", pidfd_close_attempts);
  return result;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("observeLinuxProcess", Napi::Function::New(env, ObserveLinuxProcess));
  exports.Set("configure", Napi::Function::New(env, Configure));
  exports.Set("counters", Napi::Function::New(env, Counters));
  return exports;
}
}  // namespace

// Only the separately compiled production observer translation unit is renamed
// to call these wrappers. The normal addon and fixture processes use real OS
// calls. There is no production fault-injection export or environment switch.
extern "C" long ObserverFixtureSyscall(long number, ...) {
  va_list arguments;
  va_start(arguments, number);
  const int pid = va_arg(arguments, int);
  const int flags = va_arg(arguments, int);
  va_end(arguments);
  if (number != SYS_pidfd_open) {
    errno = EINVAL;
    return -1;
  }
  ++pidfd_calls;
  pidfd_flags = flags;
  if (fault == "unsupported" || fault == "permission" || fault == "exhausted") {
    errno = fault == "unsupported" ? ENOSYS : fault == "permission" ? EPERM : EMFILE;
    return -1;
  }
  pidfd = static_cast<int>(syscall(number, pid, flags));
  if (pidfd != -1) {
    owned.insert(pidfd);
  }
  return pidfd;
}

extern "C" int ObserverFixtureOpen(const char* path, int flags, ...) {
  if (fault == "metadata-error" && std::string(path).find("/proc/self/fdinfo/") == 0) {
    errno = EACCES;
    return -1;
  }
  const int fd = open(path, flags);
  if (fd != -1) {
    owned.insert(fd);
    if (fault == "namespace" && std::string(path) == "/proc/self/status") {
      replacement[fd] = "Pid:\t" + std::to_string(getpid()) + "\nNSpid:\t" +
                        std::to_string(getpid()) + "\t" + std::to_string(getpid()) + "\n";
    }
    if (std::string(path).find("/proc/self/fdinfo/") == 0) {
      ++fdinfo_reads;
      if (fault == "reaped-during-reader" && fdinfo_reads == 2) {
        replacement[fd] = "Pid:\t-1\nNSpid:\t-1\n";
      }
    }
  }
  return fd;
}

extern "C" ssize_t ObserverFixtureRead(int fd, void* buffer, size_t count) {
  auto found = replacement.find(fd);
  if (found == replacement.end()) {
    return read(fd, buffer, count);
  }
  const size_t length = std::min(count, found->second.size());
  found->second.copy(static_cast<char*>(buffer), length);
  found->second.erase(0, length);
  return static_cast<ssize_t>(length);
}

extern "C" int ObserverFixturePoll(pollfd* descriptors, nfds_t count, int timeout) {
  ++poll_calls;
  if (fault == "poll-error" || fault == "poll-interrupted") {
    errno = fault == "poll-error" ? EIO : EINTR;
    return -1;
  }
  if (fault == "poll-invalid" || fault == "poll-unknown") {
    descriptors[0].revents = fault == "poll-invalid" ? POLLNVAL : POLLIN | POLLOUT;
    return 1;
  }
  return poll(descriptors, count, timeout);
}

extern "C" int ObserverFixtureClose(int fd) {
  if (fd == pidfd) {
    ++pidfd_close_attempts;
  }
  replacement.erase(fd);
  owned.erase(fd);
  const int result = close(fd);
  if ((fault == "close-error" || fault == "close-interrupted") && fd == pidfd) {
    // Release the real descriptor, then expose a close failure to the exact
    // production implementation; returning a positive observation is forbidden.
    errno = fault == "close-error" ? EIO : EINTR;
    return -1;
  }
  return result;
}

NODE_API_MODULE(linux_observer_faults, Init)
