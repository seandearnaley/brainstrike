#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <sched.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

static int writer_fd;
static const char* executable;

static void write_owned(void) {
  const char message[] = "worker alive\n";
  if (write(writer_fd, message, sizeof(message) - 1) != sizeof(message) - 1) {
    _exit(21);
  }
  puts("written");
}

static void commands(void) {
  char command;
  while (read(STDIN_FILENO, &command, 1) == 1) {
    if (command == 'W') {
      write_owned();
    } else if (command == 'E') {
      char descriptor[32];
      snprintf(descriptor, sizeof(descriptor), "%d", writer_fd);
      execl(executable, executable, "execed", descriptor, NULL);
      _exit(22);
    } else if (command == 'Q') {
      return;
    }
  }
}

static void* worker(void* ignored) {
  (void)ignored;
  // Report readiness only after the real leader is Z, while this worker and
  // its shared writer descriptor remain alive. This is the unsafe ca3 case.
  for (;;) {
    FILE* status = fopen("/proc/self/stat", "r");
    if (status == NULL) {
      _exit(23);
    }
    char line[4096];
    if (fgets(line, sizeof(line), status) == NULL) {
      _exit(24);
    }
    fclose(status);
    char* end_name = strrchr(line, ')');
    if (end_name != NULL && end_name[2] == 'Z') {
      break;
    }
    sched_yield();
  }
  puts("ready");
  commands();
  return NULL;
}

int main(int argc, char** argv) {
  setvbuf(stdout, NULL, _IONBF, 0);
  executable = argv[0];
  if (argc == 3 && strcmp(argv[1], "execed") == 0) {
    writer_fd = atoi(argv[2]);
    puts("execed");
    commands();
    return 0;
  }
  if (argc != 2) {
    return 25;
  }
  int control[2];
  int events[2];
  if (pipe(control) != 0 || pipe(events) != 0) {
    return 26;
  }
  const pid_t pid = fork();
  if (pid == -1) {
    return 27;
  }
  if (pid == 0) {
    close(control[1]);
    close(events[0]);
    if (dup2(control[0], STDIN_FILENO) == -1 ||
        dup2(events[1], STDOUT_FILENO) == -1) {
      _exit(28);
    }
    close(control[0]);
    close(events[1]);
    writer_fd = open(argv[1], O_WRONLY | O_CREAT | O_APPEND, 0600);
    if (writer_fd == -1) {
      _exit(29);
    }
    pthread_t thread;
    if (pthread_create(&thread, NULL, worker, NULL) != 0) {
      _exit(30);
    }
    pthread_exit(NULL);
  }
  close(control[0]);
  close(events[1]);
  int outcome = 0;
  int exited = 0;
  FILE* child_events = fdopen(events[0], "r");
  if (child_events == NULL) {
    outcome = 31;
    goto join_child;
  }
  // A child that exits before a command must produce EPIPE, not terminate the
  // supervisor before it can join that owned child.
  if (signal(SIGPIPE, SIG_IGN) == SIG_ERR) {
    outcome = 37;
    goto join_child;
  }
  char line[128];
  if (fgets(line, sizeof(line), child_events) == NULL) {
    outcome = 32;
    goto join_child;
  }
  printf("{\"event\":\"ready\",\"pid\":%d}\n", pid);
  char command;
  while (read(STDIN_FILENO, &command, 1) == 1) {
    if (command == '\n') {
      continue;
    }
    if (command == 'R') {
      break;
    }
    if (write(control[1], &command, 1) != 1) {
      outcome = 33;
      goto join_child;
    }
    if (command == 'Q') {
      siginfo_t observed;
      memset(&observed, 0, sizeof(observed));
      if (waitid(P_PID, (id_t)pid, &observed, WEXITED | WNOWAIT) != 0 ||
          observed.si_pid != pid || observed.si_code != CLD_EXITED ||
          observed.si_status != 0) {
        outcome = 34;
        goto join_child;
      }
      exited = 1;
      printf("{\"event\":\"exited\",\"pid\":%d}\n", pid);
    } else {
      if (fgets(line, sizeof(line), child_events) == NULL) {
        outcome = 35;
        goto join_child;
      }
      line[strcspn(line, "\n")] = '\0';
      printf("{\"event\":\"%s\",\"pid\":%d}\n", line, pid);
    }
  }
  // EOF is cooperative teardown too. The child exits when its control pipe
  // closes; always physically join it before the fixture supervisor returns.
join_child:
  close(control[1]);
  int status;
  pid_t joined;
  do {
    joined = waitpid(pid, &status, 0);
  } while (joined == -1 && errno == EINTR);
  if ((joined != pid || !WIFEXITED(status) || WEXITSTATUS(status) != 0) && outcome == 0) {
    outcome = 36;
  }
  if (child_events != NULL) {
    fclose(child_events);
  } else {
    close(events[0]);
  }
  if (exited && outcome == 0) {
    printf("{\"event\":\"reaped\",\"pid\":%d}\n", pid);
  }
  return outcome;
}
