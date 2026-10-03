// M0-A1 kernel-sync probe.
//   macOS: DYLD_INSERT_LIBRARIES (this node binary carries com.apple.security.cs.allow-dyld-environment-variables);
//          interposes fsync, fsync$NOCANCEL, fdatasync, fcntl / fcntl$NOCANCEL (F_FULLFSYNC, F_BARRIERFSYNC).
//   Linux: LD_PRELOAD; wraps fsync and fdatasync (dlsym RTLD_NEXT). strace runs alongside as the syscall-level count.
// One TSV line per call to $M0_SYNCSPY_LOG:
//   op  tid  is_main  thread_name  t0_ms  t1_ms  fd  rc  errno  path
// t0/t1 use libuv's uv_hrtime clock (macOS mach_continuous_time, libuv 1.52.1 src/unix/darwin.c:60-63; Linux
// CLOCK_MONOTONIC, src/unix/linux.c:1603-1616), i.e. the clock behind process.hrtime.bigint(), so calls can be placed
// exactly inside the JS-recorded spans without mixing a wall-clock anchor in.
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#ifdef __APPLE__
#include <mach/mach_time.h>
#include <sys/param.h>
#else
#include <dlfcn.h>
#include <limits.h>
#include <sys/syscall.h>
#define MAXPATHLEN PATH_MAX
#endif

static int logfd = -1;
__attribute__((constructor)) static void syncspy_init(void) {
  const char *p = getenv("M0_SYNCSPY_LOG");
  if (p && *p) logfd = open(p, O_WRONLY | O_CREAT | O_APPEND, 0644);
}

static double now_ms(void) {
#ifdef __APPLE__
  static mach_timebase_info_data_t tb;
  if (tb.denom == 0) mach_timebase_info(&tb);
  return (double)(mach_continuous_time() * tb.numer / tb.denom) / 1e6;
#else
  struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts);
  return (double)ts.tv_sec * 1e3 + (double)ts.tv_nsec / 1e6;
#endif
}

static void rec(const char *op, int fd, double t0, double t1, int rc, int err) {
  if (logfd < 0) return;
  char path[MAXPATHLEN + 1];
#ifdef __APPLE__
  if (fcntl(fd, F_GETPATH, path) == -1) strcpy(path, "?");
  uint64_t tid = 0; pthread_threadid_np(NULL, &tid);
  int is_main = pthread_main_np();
#else
  char lnk[64]; snprintf(lnk, sizeof lnk, "/proc/self/fd/%d", fd);
  ssize_t n0 = readlink(lnk, path, MAXPATHLEN);
  if (n0 < 0) strcpy(path, "?"); else path[n0] = 0;
  uint64_t tid = (uint64_t)syscall(SYS_gettid);
  int is_main = tid == (uint64_t)getpid();
#endif
  char name[64] = ""; pthread_getname_np(pthread_self(), name, sizeof name);
  char line[MAXPATHLEN + 256];
  int n = snprintf(line, sizeof line, "%s\t%llu\t%d\t%s\t%.4f\t%.4f\t%d\t%d\t%d\t%s\n", op, (unsigned long long)tid, is_main, name, t0, t1, fd, rc, err, path);
  if (n > 0) { ssize_t w = write(logfd, line, (size_t)(n < (int)sizeof line ? n : (int)sizeof line - 1)); (void)w; }
}

#ifdef __APPLE__
#define DYLD_INTERPOSE(_replacement, _replacee) \
  __attribute__((used)) static struct { const void *replacement; const void *replacee; } _interpose_##_replacee \
  __attribute__((section("__DATA,__interpose"))) = { (const void *)(unsigned long)&_replacement, (const void *)(unsigned long)&_replacee };
#ifndef F_BARRIERFSYNC
#define F_BARRIERFSYNC 85
#endif
extern int fsync_nocancel(int) __asm("_fsync$NOCANCEL");
extern int fcntl_nocancel(int, int, ...) __asm("_fcntl$NOCANCEL");
extern int fdatasync(int);

static int spy_fsync(int fd) { double t0 = now_ms(); int r = fsync(fd); int e = errno; rec("fsync", fd, t0, now_ms(), r, r ? e : 0); errno = e; return r; }
static int spy_fsync_nc(int fd) { double t0 = now_ms(); int r = fsync_nocancel(fd); int e = errno; rec("fsync$NOCANCEL", fd, t0, now_ms(), r, r ? e : 0); errno = e; return r; }
static int spy_fdatasync(int fd) { double t0 = now_ms(); int r = fdatasync(fd); int e = errno; rec("fdatasync", fd, t0, now_ms(), r, r ? e : 0); errno = e; return r; }
static const char *sync_cmd(int cmd) { return cmd == F_FULLFSYNC ? "F_FULLFSYNC" : cmd == F_BARRIERFSYNC ? "F_BARRIERFSYNC" : NULL; }
static int spy_fcntl(int fd, int cmd, ...) {
  va_list ap; va_start(ap, cmd); void *arg = va_arg(ap, void *); va_end(ap);
  const char *op = sync_cmd(cmd);
  if (!op) return fcntl(fd, cmd, arg);
  double t0 = now_ms(); int r = fcntl(fd, cmd, arg); int e = errno; rec(op, fd, t0, now_ms(), r, r == -1 ? e : 0); errno = e; return r;
}
static int spy_fcntl_nc(int fd, int cmd, ...) {
  va_list ap; va_start(ap, cmd); void *arg = va_arg(ap, void *); va_end(ap);
  const char *op = sync_cmd(cmd);
  if (!op) return fcntl_nocancel(fd, cmd, arg);
  double t0 = now_ms(); int r = fcntl_nocancel(fd, cmd, arg); int e = errno; rec(op, fd, t0, now_ms(), r, r == -1 ? e : 0); errno = e; return r;
}
DYLD_INTERPOSE(spy_fsync, fsync)
DYLD_INTERPOSE(spy_fsync_nc, fsync_nocancel)
DYLD_INTERPOSE(spy_fdatasync, fdatasync)
DYLD_INTERPOSE(spy_fcntl, fcntl)
DYLD_INTERPOSE(spy_fcntl_nc, fcntl_nocancel)
#else
int fsync(int fd) {
  static int (*real)(int); if (!real) real = (int (*)(int))dlsym(RTLD_NEXT, "fsync");
  double t0 = now_ms(); int r = real(fd); int e = errno; rec("fsync", fd, t0, now_ms(), r, r ? e : 0); errno = e; return r;
}
int fdatasync(int fd) {
  static int (*real)(int); if (!real) real = (int (*)(int))dlsym(RTLD_NEXT, "fdatasync");
  double t0 = now_ms(); int r = real(fd); int e = errno; rec("fdatasync", fd, t0, now_ms(), r, r ? e : 0); errno = e; return r;
}
#endif
