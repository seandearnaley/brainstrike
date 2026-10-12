#include <napi.h>

#include <algorithm>
#include <cerrno>
#include <climits>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <memory>
#include <mutex>
#include <random>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <Windows.h>
#include <aclapi.h>
#include <winternl.h>
#ifndef FILE_DIRECTORY_FILE
#define FILE_DIRECTORY_FILE 0x00000001
#endif
#ifndef FILE_OPEN
#define FILE_OPEN 0x00000001
#endif
#ifndef FILE_CREATE
#define FILE_CREATE 0x00000002
#endif
#ifndef FILE_SYNCHRONOUS_IO_NONALERT
#define FILE_SYNCHRONOUS_IO_NONALERT 0x00000020
#endif
#ifndef FILE_NON_DIRECTORY_FILE
#define FILE_NON_DIRECTORY_FILE 0x00000040
#endif
#ifndef FILE_OPEN_REPARSE_POINT
#define FILE_OPEN_REPARSE_POINT 0x00200000
#endif
#ifndef OBJ_DONT_REPARSE
#define OBJ_DONT_REPARSE 0x00001000L
#endif
#ifndef InitializeObjectAttributes
#define InitializeObjectAttributes(attributes, name, flags, root, descriptor) \
  do {                                                                    \
    (attributes)->Length = sizeof(OBJECT_ATTRIBUTES);                      \
    (attributes)->RootDirectory = (root);                                  \
    (attributes)->Attributes = (flags);                                    \
    (attributes)->ObjectName = (name);                                     \
    (attributes)->SecurityDescriptor = (descriptor);                       \
    (attributes)->SecurityQualityOfService = nullptr;                      \
  } while (0)
#endif
#else
#include <dirent.h>
#include <fcntl.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>
#endif

namespace {

struct DirEntry {
  std::string name;
  bool is_directory;
  bool is_file;
  bool is_symbolic_link;
  uint64_t size;
  double last_modified;
};

bool IsWholeNumberInRange(double value, double minimum, double maximum) {
  return std::isfinite(value) && value >= minimum && value <= maximum &&
         std::floor(value) == value;
}

std::vector<std::string> SplitRelativePath(const std::string& path, bool* valid) {
  *valid = false;
  if (path.empty() || path == ".") {
    *valid = true;
    return {};
  }
  if (path.front() == '/' || path.find('\0') != std::string::npos) {
    return {};
  }
#ifdef _WIN32
  if (path.front() == '\\') {
    return {};
  }
#endif

  std::vector<std::string> components;
  std::string current;
  for (const char character : path) {
    bool is_separator = character == '/';
#ifdef _WIN32
    is_separator = is_separator || character == '\\';
#endif
    if (is_separator) {
      if (current.empty() || current == "." || current == "..") {
        return {};
      }
#ifdef _WIN32
      if (current.find(':') != std::string::npos) {
        return {};
      }
#endif
      components.push_back(current);
      current.clear();
      continue;
    }
    current.push_back(character);
  }
  if (current.empty() || current == "." || current == "..") {
    return {};
  }
#ifdef _WIN32
  if (current.find(':') != std::string::npos) {
    return {};
  }
#endif
  components.push_back(current);
  *valid = true;
  return components;
}

#ifdef _WIN32

using NativeHandle = HANDLE;
const NativeHandle kInvalidHandle = INVALID_HANDLE_VALUE;

std::wstring Utf8ToWide(const std::string& value) {
  if (value.empty()) {
    return {};
  }
  const int length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
                                         static_cast<int>(value.size()), nullptr, 0);
  if (length <= 0) {
    return {};
  }
  std::wstring result(static_cast<size_t>(length), L'\0');
  if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
                          static_cast<int>(value.size()), result.data(), length) != length) {
    return {};
  }
  return result;
}

std::string WideToUtf8(const wchar_t* value, size_t length) {
  if (length == 0) {
    return {};
  }
  const int output_length = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value,
                                                 static_cast<int>(length), nullptr, 0, nullptr,
                                                 nullptr);
  if (output_length <= 0) {
    return {};
  }
  std::string result(static_cast<size_t>(output_length), '\0');
  if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value, static_cast<int>(length),
                          result.data(), output_length, nullptr, nullptr) != output_length) {
    return {};
  }
  return result;
}

void CloseNativeHandle(NativeHandle handle) {
  if (handle != kInvalidHandle) {
    CloseHandle(handle);
  }
}

double WindowsTimeToUnixMilliseconds(const LARGE_INTEGER& value) {
  constexpr int64_t kWindowsToUnixEpoch100Nanoseconds = 116'444'736'000'000'000LL;
  return static_cast<double>(value.QuadPart - kWindowsToUnixEpoch100Nanoseconds) / 10'000.0;
}

bool IsReparsePoint(NativeHandle handle) {
  FILE_ATTRIBUTE_TAG_INFO attributes{};
  return !GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &attributes,
                                       sizeof(attributes)) ||
         (attributes.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0;
}

using NtCreateFileFn = NTSTATUS(NTAPI*)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES,
                                       PIO_STATUS_BLOCK, PLARGE_INTEGER, ULONG, ULONG, ULONG,
                                       ULONG, PVOID, ULONG);

NtCreateFileFn ResolveNtCreateFile() {
  static const auto function = reinterpret_cast<NtCreateFileFn>(
      GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtCreateFile"));
  return function;
}

NativeHandle OpenRelativeComponent(NativeHandle parent, const std::wstring& name,
                                   bool directory, bool* not_found = nullptr,
                                   ACCESS_MASK extra_access = 0) {
  if (not_found != nullptr) {
    *not_found = false;
  }
  const auto nt_create_file = ResolveNtCreateFile();
  if (nt_create_file == nullptr || name.empty() || name.size() > 32767) {
    return kInvalidHandle;
  }

  UNICODE_STRING object_name{};
  object_name.Buffer = const_cast<PWSTR>(name.data());
  object_name.Length = static_cast<USHORT>(name.size() * sizeof(wchar_t));
  object_name.MaximumLength = object_name.Length;
  OBJECT_ATTRIBUTES attributes{};
  InitializeObjectAttributes(&attributes, &object_name,
                             OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE, parent, nullptr);
  IO_STATUS_BLOCK status_block{};
  HANDLE result = kInvalidHandle;
  const ACCESS_MASK access = directory
                                 ? FILE_LIST_DIRECTORY | FILE_TRAVERSE | FILE_READ_ATTRIBUTES |
                                       SYNCHRONIZE
                                 : FILE_GENERIC_READ | SYNCHRONIZE;
  const ULONG options = FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT |
                        (directory ? FILE_DIRECTORY_FILE : FILE_NON_DIRECTORY_FILE);
  const NTSTATUS status = nt_create_file(
      &result, access | extra_access, &attributes, &status_block, nullptr, FILE_ATTRIBUTE_NORMAL,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, FILE_OPEN, options, nullptr, 0);
  if (status < 0 || result == kInvalidHandle || IsReparsePoint(result)) {
    if (not_found != nullptr) {
      constexpr NTSTATUS kStatusNoSuchFile = static_cast<NTSTATUS>(0xC000000FUL);
      constexpr NTSTATUS kStatusObjectNameNotFound = static_cast<NTSTATUS>(0xC0000034UL);
      constexpr NTSTATUS kStatusObjectPathNotFound = static_cast<NTSTATUS>(0xC000003AUL);
      *not_found = status == kStatusNoSuchFile || status == kStatusObjectNameNotFound ||
                   status == kStatusObjectPathNotFound;
    }
    CloseNativeHandle(result);
    return kInvalidHandle;
  }
  return result;
}

NativeHandle OpenAbsoluteDirectory(const std::string& utf8_path, bool* missing) {
  *missing = false;
  std::wstring path = Utf8ToWide(utf8_path);
  if (path.empty() || path.find(L'\0') != std::wstring::npos) {
    return kInvalidHandle;
  }
  for (wchar_t& character : path) {
    if (character == L'/') {
      character = L'\\';
    }
  }
  // Reject anything that is not drive-absolute (X:\..., optionally with the
  // \\?\ extended-length prefix) or UNC (\\server\share\...): CreateFileW
  // resolves a relative path against the process CWD, which would silently
  // widen the trusted root beyond what the caller requested.
  bool is_absolute;
  if (path.rfind(L"\\\\?\\UNC\\", 0) == 0) {
    is_absolute = true;
  } else if (path.rfind(L"\\\\?\\", 0) == 0) {
    is_absolute = path.size() >= 7 && path[5] == L':' && path[6] == L'\\';
  } else if (path.rfind(L"\\\\", 0) == 0) {
    is_absolute = true;
  } else {
    is_absolute = path.size() >= 3 && path[1] == L':' && path[2] == L'\\';
  }
  if (!is_absolute) {
    return kInvalidHandle;
  }
  const NativeHandle handle = CreateFileW(
      path.c_str(),
      FILE_LIST_DIRECTORY | FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS, nullptr);
  if (handle == kInvalidHandle) {
    const DWORD error = GetLastError();
    *missing = error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND;
    return kInvalidHandle;
  }
  // Without FILE_FLAG_OPEN_REPARSE_POINT the open resolved any reparse points;
  // the final object must be a plain directory.
  FILE_BASIC_INFO info{};
  if (!GetFileInformationByHandleEx(handle, FileBasicInfo, &info, sizeof(info)) ||
      (info.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0 ||
      (info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
    CloseNativeHandle(handle);
    return kInvalidHandle;
  }
  return handle;
}

std::string DeriveCanonicalPath(NativeHandle handle) {
  std::wstring buffer(512, L'\0');
  for (;;) {
    const DWORD length = GetFinalPathNameByHandleW(
        handle, buffer.data(), static_cast<DWORD>(buffer.size()),
        FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
    if (length == 0) {
      return {};
    }
    if (length < buffer.size()) {
      buffer.resize(length);
      break;
    }
    buffer.resize(static_cast<size_t>(length) + 1);
  }
  if (buffer.rfind(L"\\\\?\\UNC\\", 0) == 0) {
    buffer = L"\\\\" + buffer.substr(8);
  } else if (buffer.rfind(L"\\\\?\\", 0) == 0) {
    buffer = buffer.substr(4);
  }
  return WideToUtf8(buffer.data(), buffer.size());
}

NativeHandle OpenRelativeDirectory(NativeHandle root,
                                   const std::vector<std::string>& components,
                                   bool* not_found = nullptr) {
  if (not_found != nullptr) {
    *not_found = false;
  }
  if (components.empty()) {
    return kInvalidHandle;
  }
  bool component_not_found = false;
  NativeHandle current = root;
  bool owns_current = false;
  for (const auto& component : components) {
    const std::wstring wide_component = Utf8ToWide(component);
    NativeHandle next =
        OpenRelativeComponent(current, wide_component, true, &component_not_found);
    if (owns_current) {
      CloseNativeHandle(current);
    }
    if (next == kInvalidHandle) {
      if (not_found != nullptr) {
        *not_found = component_not_found;
      }
      return kInvalidHandle;
    }
    current = next;
    owns_current = true;
  }
  return current;
}

// Reopens the directory that `root` refers to via a handle-relative open with
// an empty name, yielding an independent open (and enumeration cursor) on the
// same directory object. Never resolves through a path. No post-open reparse
// re-check is needed here: the constructor already rejected a reparse-point
// root, and a by-handle reopen with an empty name resolves no path component
// (nothing to re-traverse or re-reparse) — it can only ever hand back the
// same underlying directory object `root` already refers to.
NativeHandle ReopenDirectory(NativeHandle root) {
  const auto nt_create_file = ResolveNtCreateFile();
  if (nt_create_file == nullptr) {
    return kInvalidHandle;
  }
  UNICODE_STRING empty_name{};
  static wchar_t kEmpty[] = L"";
  empty_name.Buffer = kEmpty;
  empty_name.Length = 0;
  empty_name.MaximumLength = sizeof(kEmpty);
  OBJECT_ATTRIBUTES attributes{};
  InitializeObjectAttributes(&attributes, &empty_name,
                             OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE, root, nullptr);
  IO_STATUS_BLOCK status_block{};
  HANDLE result = kInvalidHandle;
  const NTSTATUS status = nt_create_file(
      &result,
      FILE_LIST_DIRECTORY | FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
      &attributes, &status_block, nullptr, FILE_ATTRIBUTE_NORMAL,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, FILE_OPEN,
      FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT | FILE_DIRECTORY_FILE,
      nullptr, 0);
  if (status < 0 || result == kInvalidHandle) {
    return kInvalidHandle;
  }
  return result;
}

bool ListDirectory(NativeHandle root, const std::vector<std::string>& components,
                   size_t max_entries, std::vector<DirEntry>* entries, size_t* inspected,
                   bool* truncated) {
  NativeHandle directory =
      components.empty() ? ReopenDirectory(root) : OpenRelativeDirectory(root, components);
  if (directory == kInvalidHandle) {
    return false;
  }
  std::vector<std::byte> buffer(64 * 1024);
  bool restart = true;
  *inspected = 0;
  *truncated = false;
  for (;;) {
    const auto information_class =
        restart ? FileIdBothDirectoryRestartInfo : FileIdBothDirectoryInfo;
    if (!GetFileInformationByHandleEx(directory, information_class, buffer.data(),
                                      static_cast<DWORD>(buffer.size()))) {
      const DWORD error = GetLastError();
      CloseNativeHandle(directory);
      return error == ERROR_NO_MORE_FILES;
    }
    restart = false;
    size_t offset = 0;
    for (;;) {
      const auto* information = reinterpret_cast<const FILE_ID_BOTH_DIR_INFO*>(buffer.data() + offset);
      const size_t name_length = information->FileNameLength / sizeof(wchar_t);
      const std::wstring_view name(information->FileName, name_length);
      if (name != L"." && name != L"..") {
        if (*inspected >= max_entries) {
          *truncated = true;
          CloseNativeHandle(directory);
          return true;
        }
        *inspected += 1;
      }
      if (name != L"." && name != L"..") {
        const std::string utf8_name = WideToUtf8(name.data(), name.size());
        if (!utf8_name.empty()) {
          const bool is_symbolic_link =
              (information->FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0;
          const bool is_directory = !is_symbolic_link &&
              (information->FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
          const bool is_file = !is_symbolic_link && !is_directory;
          entries->push_back({utf8_name, is_directory, is_file, is_symbolic_link,
                              is_file ? static_cast<uint64_t>(information->EndOfFile.QuadPart) : 0,
                              is_file
                                  ? WindowsTimeToUnixMilliseconds(information->LastWriteTime)
                                  : 0.0});
        }
      }
      if (information->NextEntryOffset == 0) {
        break;
      }
      offset += information->NextEntryOffset;
    }
  }
}

enum class ReadStatus { kNotFound, kOk, kOversized, kUnreadable };

ReadStatus ReadRelativeFile(NativeHandle root, const std::vector<std::string>& components,
                            size_t max_bytes, std::vector<uint8_t>* content) {
  if (components.empty()) {
    return ReadStatus::kUnreadable;
  }
  std::vector<std::string> parent_components(components.begin(), components.end() - 1);
  bool not_found = false;
  const bool borrowed_root = parent_components.empty();
  NativeHandle parent =
      borrowed_root ? root : OpenRelativeDirectory(root, parent_components, &not_found);
  if (parent == kInvalidHandle) {
    return not_found ? ReadStatus::kNotFound : ReadStatus::kUnreadable;
  }
  NativeHandle file =
      OpenRelativeComponent(parent, Utf8ToWide(components.back()), false, &not_found);
  if (!borrowed_root) {
    CloseNativeHandle(parent);
  }
  if (file == kInvalidHandle) {
    return not_found ? ReadStatus::kNotFound : ReadStatus::kUnreadable;
  }
  FILE_STANDARD_INFO information{};
  if (!GetFileInformationByHandleEx(file, FileStandardInfo, &information, sizeof(information))) {
    CloseNativeHandle(file);
    return ReadStatus::kUnreadable;
  }
  if (information.EndOfFile.QuadPart > static_cast<LONGLONG>(max_bytes)) {
    CloseNativeHandle(file);
    return ReadStatus::kOversized;
  }
  content->resize(max_bytes + 1);
  size_t total = 0;
  while (total < content->size()) {
    DWORD bytes_read = 0;
    const DWORD requested = static_cast<DWORD>(content->size() - total);
    if (!ReadFile(file, content->data() + total, requested, &bytes_read, nullptr)) {
      CloseNativeHandle(file);
      return ReadStatus::kUnreadable;
    }
    if (bytes_read == 0) {
      break;
    }
    total += bytes_read;
  }
  CloseNativeHandle(file);
  if (total > max_bytes) {
    return ReadStatus::kOversized;
  }
  content->resize(total);
  return ReadStatus::kOk;
}

#else

using NativeHandle = int;
constexpr NativeHandle kInvalidHandle = -1;

void CloseNativeHandle(NativeHandle handle) {
  if (handle != kInvalidHandle) {
    close(handle);
  }
}

NativeHandle OpenAbsoluteDirectory(const std::string& path, bool* missing) {
  *missing = false;
  if (path.empty() || path.front() != '/' || path.find('\0') != std::string::npos) {
    return kInvalidHandle;
  }
  // Root establishment follows symlinks by design: the path comes from the
  // trusted folder picker or persisted store, never from repository content.
  // Descendant resolution below this handle remains strictly no-follow.
  const auto handle = open(path.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  *missing = handle == kInvalidHandle && errno == ENOENT;
  return handle;
}

#ifdef __APPLE__
std::string DeriveCanonicalPath(NativeHandle handle) {
  char buffer[PATH_MAX];
  if (fcntl(handle, F_GETPATH, buffer) == -1) {
    return {};
  }
  return std::string(buffer);
}
#else
std::string DeriveCanonicalPath(NativeHandle handle) {
  const std::string link = "/proc/self/fd/" + std::to_string(handle);
  std::string buffer(512, '\0');
  for (;;) {
    const ssize_t length = readlink(link.c_str(), buffer.data(), buffer.size());
    if (length < 0) {
      return {};
    }
    if (static_cast<size_t>(length) < buffer.size()) {
      buffer.resize(static_cast<size_t>(length));
      break;
    }
    buffer.resize(buffer.size() * 2);
  }
  // The kernel appends this suffix when the target was unlinked between open
  // and readlink; the string is no longer a real path, so fail closed rather
  // than key identity off a corrupted value.
  constexpr std::string_view kDeletedSuffix = " (deleted)";
  if (buffer.size() >= kDeletedSuffix.size() &&
      buffer.compare(buffer.size() - kDeletedSuffix.size(), kDeletedSuffix.size(),
                     kDeletedSuffix) == 0) {
    return {};
  }
  return buffer;
}
#endif

NativeHandle OpenRelativeDirectory(NativeHandle root,
                                   const std::vector<std::string>& components,
                                   bool* not_found = nullptr) {
  if (not_found != nullptr) {
    *not_found = false;
  }
  // `dup` would share the directory offset with the pinned root's open-file
  // description. Opening `.` relative to the pinned descriptor creates an
  // independent description so concurrent/repeated listings cannot consume
  // one another's readdir position.
  NativeHandle current =
      openat(root, ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (current == kInvalidHandle) {
    return kInvalidHandle;
  }
  for (const auto& component : components) {
    const NativeHandle next =
        openat(current, component.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    const int open_error = errno;
    CloseNativeHandle(current);
    if (next == kInvalidHandle) {
      if (not_found != nullptr) {
        *not_found = open_error == ENOENT;
      }
      return kInvalidHandle;
    }
    current = next;
  }
  return current;
}

bool ListDirectory(NativeHandle root, const std::vector<std::string>& components,
                   size_t max_entries, std::vector<DirEntry>* entries, size_t* inspected,
                   bool* truncated) {
  NativeHandle directory_fd = OpenRelativeDirectory(root, components);
  if (directory_fd == kInvalidHandle) {
    return false;
  }
  DIR* directory = fdopendir(directory_fd);
  if (directory == nullptr) {
    CloseNativeHandle(directory_fd);
    return false;
  }
  bool succeeded = true;
  *inspected = 0;
  *truncated = false;
  for (;;) {
    errno = 0;
    const dirent* entry = readdir(directory);
    if (entry == nullptr) {
      succeeded = errno == 0;
      break;
    }
    if (std::strcmp(entry->d_name, ".") == 0 || std::strcmp(entry->d_name, "..") == 0) {
      continue;
    }
    if (*inspected >= max_entries) {
      *truncated = true;
      break;
    }
    *inspected += 1;
    struct stat information {};
    if (fstatat(dirfd(directory), entry->d_name, &information, AT_SYMLINK_NOFOLLOW) != 0) {
      continue;
    }
    const bool is_directory = S_ISDIR(information.st_mode);
    const bool is_file = S_ISREG(information.st_mode);
    const bool is_symbolic_link = S_ISLNK(information.st_mode);
#ifdef __APPLE__
    const double last_modified = static_cast<double>(information.st_mtimespec.tv_sec) * 1000.0 +
                                 static_cast<double>(information.st_mtimespec.tv_nsec) / 1'000'000.0;
#else
    const double last_modified = static_cast<double>(information.st_mtim.tv_sec) * 1000.0 +
                                 static_cast<double>(information.st_mtim.tv_nsec) / 1'000'000.0;
#endif
    entries->push_back({entry->d_name, is_directory, is_file, is_symbolic_link,
                        is_file ? static_cast<uint64_t>(information.st_size) : 0,
                        is_file ? last_modified : 0.0});
  }
  closedir(directory);
  return succeeded;
}

enum class ReadStatus { kNotFound, kOk, kOversized, kUnreadable };

ReadStatus ReadRelativeFile(NativeHandle root, const std::vector<std::string>& components,
                            size_t max_bytes, std::vector<uint8_t>* content) {
  if (components.empty()) {
    return ReadStatus::kUnreadable;
  }
  std::vector<std::string> parent_components(components.begin(), components.end() - 1);
  bool not_found = false;
  NativeHandle parent = OpenRelativeDirectory(root, parent_components, &not_found);
  if (parent == kInvalidHandle) {
    return not_found ? ReadStatus::kNotFound : ReadStatus::kUnreadable;
  }
  const NativeHandle file =
      openat(parent, components.back().c_str(), O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  const int open_error = errno;
  CloseNativeHandle(parent);
  if (file == kInvalidHandle) {
    return open_error == ENOENT ? ReadStatus::kNotFound : ReadStatus::kUnreadable;
  }
  struct stat information {};
  if (fstat(file, &information) != 0 || !S_ISREG(information.st_mode)) {
    CloseNativeHandle(file);
    return ReadStatus::kUnreadable;
  }
  if (information.st_size > static_cast<off_t>(max_bytes)) {
    CloseNativeHandle(file);
    return ReadStatus::kOversized;
  }
  content->resize(max_bytes + 1);
  size_t total = 0;
  while (total < content->size()) {
    const ssize_t bytes_read = read(file, content->data() + total, content->size() - total);
    if (bytes_read < 0) {
      if (errno == EINTR) {
        continue;
      }
      CloseNativeHandle(file);
      return ReadStatus::kUnreadable;
    }
    if (bytes_read == 0) {
      break;
    }
    total += static_cast<size_t>(bytes_read);
  }
  CloseNativeHandle(file);
  if (total > max_bytes) {
    return ReadStatus::kOversized;
  }
  content->resize(total);
  return ReadStatus::kOk;
}

#endif

// Private-file operations keep traversal, permission validation and byte I/O on
// pinned handles. No pathname ACL command or pathname fallback is involved.
class PrivateHandle {
 public:
  explicit PrivateHandle(NativeHandle value = kInvalidHandle) : value_(value) {}
  PrivateHandle(const PrivateHandle&) = delete;
  PrivateHandle& operator=(const PrivateHandle&) = delete;
  ~PrivateHandle() { CloseNativeHandle(value_); }
  NativeHandle Get() const { return value_; }
  bool Close() {
    const NativeHandle value = std::exchange(value_, kInvalidHandle);
    if (value == kInvalidHandle) return true;
#ifdef _WIN32
    return CloseHandle(value) != 0;
#else
    // Never retry close: EINTR may already have released/reused the descriptor.
    return close(value) == 0;
#endif
  }

 private:
  NativeHandle value_;
};

NativeHandle OpenPrivateParent(NativeHandle root, const std::vector<std::string>& components,
                               bool* missing) {
#ifdef _WIN32
  return components.empty() ? ReopenDirectory(root)
                            : OpenRelativeDirectory(root, components, missing);
#else
  return OpenRelativeDirectory(root, components, missing);
#endif
}

#ifdef _WIN32
class PrivateSecurity {
 public:
  PrivateSecurity() {
    HANDLE token = nullptr;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return;
    PrivateHandle owned_token(token);
    DWORD required = 0;
    GetTokenInformation(token, TokenUser, nullptr, 0, &required);
    if (required == 0) return;
    token_user_.resize(required);
    if (!GetTokenInformation(token, TokenUser, token_user_.data(), required, &required)) return;
    sid_ = reinterpret_cast<TOKEN_USER*>(token_user_.data())->User.Sid;
    const DWORD acl_bytes =
        sizeof(ACL) + sizeof(ACCESS_ALLOWED_ACE) - sizeof(DWORD) + GetLengthSid(sid_);
    acl_.resize(acl_bytes);
    auto* acl = reinterpret_cast<PACL>(acl_.data());
    ready_ = InitializeAcl(acl, acl_bytes, ACL_REVISION) &&
             AddAccessAllowedAceEx(acl, ACL_REVISION, 0, FILE_ALL_ACCESS, sid_) &&
             InitializeSecurityDescriptor(&descriptor_, SECURITY_DESCRIPTOR_REVISION) &&
             SetSecurityDescriptorOwner(&descriptor_, sid_, FALSE) &&
             SetSecurityDescriptorDacl(&descriptor_, TRUE, acl, FALSE) &&
             SetSecurityDescriptorControl(&descriptor_, SE_DACL_PROTECTED, SE_DACL_PROTECTED);
    if (!owned_token.Close()) ready_ = false;
  }
  bool Ready() const { return ready_; }
  PSECURITY_DESCRIPTOR Descriptor() { return &descriptor_; }
  bool Verify(NativeHandle file) const {
    if (!ready_ || GetFileType(file) != FILE_TYPE_DISK || IsReparsePoint(file)) return false;
    FILE_STANDARD_INFO info{};
    if (!GetFileInformationByHandleEx(file, FileStandardInfo, &info, sizeof(info)) ||
        info.Directory)
      return false;
    PSID owner = nullptr;
    PACL acl = nullptr;
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    const DWORD result = GetSecurityInfo(file, SE_FILE_OBJECT,
                                         OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                                         &owner, nullptr, &acl, nullptr, &descriptor);
    bool valid = false;
    if (result == ERROR_SUCCESS && owner != nullptr && acl != nullptr && IsValidSid(owner) &&
        EqualSid(owner, sid_) && IsValidAcl(acl) && acl->AceCount == 1) {
      SECURITY_DESCRIPTOR_CONTROL control = 0;
      DWORD revision = 0;
      void* raw_ace = nullptr;
      if (GetSecurityDescriptorControl(descriptor, &control, &revision) &&
          (control & SE_DACL_PROTECTED) != 0 && GetAce(acl, 0, &raw_ace)) {
        const auto* ace = static_cast<const ACCESS_ALLOWED_ACE*>(raw_ace);
        const PSID ace_sid = const_cast<DWORD*>(&ace->SidStart);
        valid = ace->Header.AceType == ACCESS_ALLOWED_ACE_TYPE && ace->Header.AceFlags == 0 &&
                ace->Mask == FILE_ALL_ACCESS && IsValidSid(ace_sid) && EqualSid(ace_sid, sid_);
      }
    }
    if (descriptor != nullptr) LocalFree(descriptor);
    return valid;
  }

 private:
  std::vector<uint8_t> token_user_;
  std::vector<uint8_t> acl_;
  PSID sid_ = nullptr;
  SECURITY_DESCRIPTOR descriptor_{};
  bool ready_ = false;
};

NativeHandle OpenPrivateLeaf(NativeHandle parent, const std::string& name, bool* missing) {
  return OpenRelativeComponent(parent, Utf8ToWide(name), false, missing, READ_CONTROL);
}

NativeHandle CreatePrivateTemporary(NativeHandle parent, const std::string& name,
                                    PrivateSecurity* security) {
  const auto create = ResolveNtCreateFile();
  const auto wide = Utf8ToWide(name);
  if (create == nullptr || !security->Ready() || wide.empty()) return kInvalidHandle;
  UNICODE_STRING object_name{};
  object_name.Buffer = const_cast<PWSTR>(wide.data());
  object_name.Length = static_cast<USHORT>(wide.size() * sizeof(wchar_t));
  object_name.MaximumLength = object_name.Length;
  OBJECT_ATTRIBUTES attributes{};
  InitializeObjectAttributes(&attributes, &object_name, OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE,
                             parent, security->Descriptor());
  IO_STATUS_BLOCK status{};
  HANDLE result = kInvalidHandle;
  const NTSTATUS outcome = create(
      &result, FILE_GENERIC_READ | FILE_GENERIC_WRITE | DELETE | READ_CONTROL | SYNCHRONIZE,
      &attributes, &status, nullptr, FILE_ATTRIBUTE_NORMAL,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, FILE_CREATE,
      FILE_SYNCHRONOUS_IO_NONALERT | FILE_NON_DIRECTORY_FILE | FILE_OPEN_REPARSE_POINT, nullptr, 0);
  if (outcome < 0) {
    CloseNativeHandle(result);
    return kInvalidHandle;
  }
  return result;
}

bool RemovePrivateTemporary(NativeHandle file, NativeHandle, const std::string&) {
  FILE_DISPOSITION_INFO disposition{};
  disposition.DeleteFile = TRUE;
  return SetFileInformationByHandle(file, FileDispositionInfo, &disposition, sizeof(disposition)) !=
         0;
}

bool ReplacePrivateTemporary(NativeHandle file, NativeHandle parent, const std::string&,
                             const std::string& target, bool posix = false) {
  // Use the NT handle-relative primitive, like traversal. The Win32 wrapper
  // rejects a non-null RootDirectory (ERROR_INVALID_PARAMETER) on SEAN9.
  // https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/nf-ntifs-ntsetinformationfile
  using SetInformationFn =
      NTSTATUS(NTAPI*)(HANDLE, PIO_STATUS_BLOCK, PVOID, ULONG, FILE_INFORMATION_CLASS);
  static const auto set_information = reinterpret_cast<SetInformationFn>(
      GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtSetInformationFile"));
  if (set_information == nullptr) {
    SetLastError(ERROR_NOT_SUPPORTED);
    return false;
  }
  const auto wide = Utf8ToWide(target);
  const size_t bytes = offsetof(FILE_RENAME_INFO, FileName) + (wide.size() + 1) * sizeof(wchar_t);
  std::vector<uint8_t> buffer(bytes);
  auto* rename = reinterpret_cast<FILE_RENAME_INFO*>(buffer.data());
  rename->ReplaceIfExists = TRUE;
  // M4 Windows release: classic replacement fails for a mapped target. POSIX
  // replacement retains existing readers while atomically publishing new bytes.
  // https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/ns-ntifs-_file_rename_information
  if (posix) {
    const ULONG flags = 0x00000001 | 0x00000002;
    std::memcpy(buffer.data(), &flags, sizeof(flags));
  }
  rename->RootDirectory = parent;
  rename->FileNameLength = static_cast<DWORD>(wide.size() * sizeof(wchar_t));
  std::memcpy(rename->FileName, wide.data(), rename->FileNameLength);
  IO_STATUS_BLOCK status{};
  const NTSTATUS result = set_information(file, &status, rename, static_cast<ULONG>(bytes),
                                          static_cast<FILE_INFORMATION_CLASS>(posix ? 65 : 10));
  if (result < 0) {
    using TranslateStatusFn = ULONG(WINAPI*)(NTSTATUS);
    const auto translate = reinterpret_cast<TranslateStatusFn>(
        GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "RtlNtStatusToDosError"));
    SetLastError(translate != nullptr ? translate(result) : ERROR_GEN_FAILURE);
  }
  return result >= 0;
}
#else
class PrivateSecurity {
 public:
  bool Ready() const { return true; }
  bool Verify(NativeHandle file) const {
    struct stat info{};
    return fstat(file, &info) == 0 && S_ISREG(info.st_mode) && (info.st_mode & 0777) == 0600;
  }
};
NativeHandle OpenPrivateLeaf(NativeHandle parent, const std::string& name, bool* missing) {
  const auto file = openat(parent, name.c_str(), O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK);
  *missing = file == kInvalidHandle && errno == ENOENT;
  return file;
}
NativeHandle CreatePrivateTemporary(NativeHandle parent, const std::string& name,
                                    PrivateSecurity*) {
  return openat(parent, name.c_str(), O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600);
}
bool RemovePrivateTemporary(NativeHandle, NativeHandle parent, const std::string& name) {
  return unlinkat(parent, name.c_str(), 0) == 0;
}
bool ReplacePrivateTemporary(NativeHandle, NativeHandle parent, const std::string& temporary,
                             const std::string& target) {
  return renameat(parent, temporary.c_str(), parent, target.c_str()) == 0;
}
#endif

ReadStatus ReadPrivateRelativeFile(NativeHandle root, const std::vector<std::string>& components,
                                   std::vector<uint8_t>* content) {
  if (components.empty()) return ReadStatus::kUnreadable;
  const std::vector<std::string> parents(components.begin(), components.end() - 1);
  bool missing = false;
  PrivateHandle parent(OpenPrivateParent(root, parents, &missing));
  if (parent.Get() == kInvalidHandle)
    return missing ? ReadStatus::kNotFound : ReadStatus::kUnreadable;
  PrivateHandle file(OpenPrivateLeaf(parent.Get(), components.back(), &missing));
  ReadStatus result = missing ? ReadStatus::kNotFound : ReadStatus::kUnreadable;
  PrivateSecurity security;
  if (file.Get() != kInvalidHandle && security.Verify(file.Get())) {
    result = ReadStatus::kOk;
    uint8_t buffer[64 * 1024];
    for (;;) {
#ifdef _WIN32
      DWORD count = 0;
      if (!ReadFile(file.Get(), buffer, sizeof(buffer), &count, nullptr)) {
        result = ReadStatus::kUnreadable;
        break;
      }
#else
      const ssize_t count = read(file.Get(), buffer, sizeof(buffer));
      if (count < 0) {
        if (errno == EINTR) continue;
        result = ReadStatus::kUnreadable;
        break;
      }
#endif
      if (count == 0) break;
      content->insert(content->end(), buffer, buffer + count);
    }
    if (!security.Verify(file.Get())) result = ReadStatus::kUnreadable;
  }
  const bool file_closed = file.Close();
  const bool parent_closed = parent.Close();
  return file_closed && parent_closed ? result : ReadStatus::kUnreadable;
}

bool PrivateTargetIsSafe(NativeHandle parent, const std::string& name,
                         const PrivateSecurity& security) {
  bool missing = false;
  PrivateHandle target(OpenPrivateLeaf(parent, name, &missing));
  const bool safe = missing || (target.Get() != kInvalidHandle && security.Verify(target.Get()));
  return target.Close() && safe;
}

std::string WritePrivateRelativeFile(NativeHandle root, const std::vector<std::string>& components,
                                     const std::vector<uint8_t>& content) {
  if (components.empty()) return "Invalid private file path";
  const std::vector<std::string> parents(components.begin(), components.end() - 1);
  bool missing = false;
  PrivateHandle parent(OpenPrivateParent(root, parents, &missing));
  if (parent.Get() == kInvalidHandle) return "Private file parent is unavailable";
  PrivateSecurity security;
  if (!security.Ready() || !PrivateTargetIsSafe(parent.Get(), components.back(), security)) {
    const bool closed = parent.Close();
    return closed ? "Private file target is unsafe or unreadable"
                  : "Private file parent close failed";
  }
  std::random_device random;
  const std::string temporary = ".brainstrike-private-" + std::to_string(random()) + "-" +
                                std::to_string(random()) + "-" + std::to_string(random()) + "-" +
                                std::to_string(random()) + ".tmp";
  PrivateHandle file(CreatePrivateTemporary(parent.Get(), temporary, &security));
  if (file.Get() == kInvalidHandle) {
    const bool closed = parent.Close();
    return closed ? "Private temporary file creation failed" : "Private file parent close failed";
  }
  std::string failure;
  bool replaced = false;
  try {
#ifndef _WIN32
    // Creation is already private; make exact 0600 independent of a restrictive umask.
    if (fchmod(file.Get(), 0600) != 0) failure = "Private temporary file permissions failed";
#endif
    if (failure.empty() && !security.Verify(file.Get()))
      failure = "Private temporary file is unsafe";
    size_t total = 0;
    while (failure.empty() && total < content.size()) {
#ifdef _WIN32
      DWORD written = 0;
      const DWORD requested =
          static_cast<DWORD>(std::min<size_t>(content.size() - total, MAXDWORD));
      if (!WriteFile(file.Get(), content.data() + total, requested, &written, nullptr) ||
          written == 0)
        failure = "Private file write failed";
#else
      const ssize_t written = write(file.Get(), content.data() + total,
                                    std::min<size_t>(content.size() - total, SSIZE_MAX));
      if (written < 0 && errno == EINTR) continue;
      if (written <= 0) failure = "Private file write failed";
#endif
      if (failure.empty()) total += static_cast<size_t>(written);
    }
    if (failure.empty()) {
#ifdef _WIN32
      if (!FlushFileBuffers(file.Get())) failure = "Private file flush failed";
#else
      if (fsync(file.Get()) != 0) failure = "Private file flush failed";
#endif
    }
    if (failure.empty()) {
      if (!security.Verify(file.Get()) ||
          !PrivateTargetIsSafe(parent.Get(), components.back(), security)) {
        failure = "Private file target is unsafe or unreadable";
      } else if (!ReplacePrivateTemporary(file.Get(), parent.Get(), temporary, components.back())) {
#ifdef _WIN32
        failure = "Private file replacement failed (Windows error " +
                  std::to_string(GetLastError()) + ")";
#else
        failure = "Private file replacement failed";
#endif
      } else {
        replaced = true;
      }
    }
  } catch (const std::exception&) {
    failure = "Private file operation failed";
  }
  if (!replaced && !RemovePrivateTemporary(file.Get(), parent.Get(), temporary))
    failure += "; private temporary file cleanup failed";
  if (!file.Close()) failure += "; private file close failed";
  if (!parent.Close()) failure += "; private file parent close failed";
  return failure;
}

Napi::Object BuildListResult(Napi::Env env, const std::vector<DirEntry>& entries,
                             size_t inspected, bool truncated) {
  const Napi::Object result = Napi::Object::New(env);
  const Napi::Array result_entries = Napi::Array::New(env, entries.size());
  for (size_t index = 0; index < entries.size(); ++index) {
    const DirEntry& source = entries[index];
    Napi::Object entry = Napi::Object::New(env);
    entry.Set("name", source.name);
    entry.Set("isDirectory", source.is_directory);
    entry.Set("isFile", source.is_file);
    entry.Set("isSymbolicLink", source.is_symbolic_link);
    if (source.is_file) {
      entry.Set("size", Napi::Number::New(env, static_cast<double>(source.size)));
      entry.Set("lastModified", Napi::Number::New(env, source.last_modified));
    }
    result_entries.Set(index, entry);
  }
  result.Set("entries", result_entries);
  result.Set("inspected", inspected);
  result.Set("truncated", truncated);
  return result;
}

Napi::Object BuildReadResult(Napi::Env env, ReadStatus status,
                             const std::vector<uint8_t>& content) {
  Napi::Object result = Napi::Object::New(env);
  if (status == ReadStatus::kOversized) {
    result.Set("status", "oversized");
  } else if (status == ReadStatus::kNotFound) {
    result.Set("status", "not-found");
  } else if (status == ReadStatus::kOk) {
    result.Set("status", "ok");
    result.Set("content", Napi::Buffer<uint8_t>::Copy(env, content.data(), content.size()));
  } else {
    result.Set("status", "unreadable");
  }
  return result;
}

struct RootHandle {
  explicit RootHandle(NativeHandle opened) : handle(opened) {}
  RootHandle(const RootHandle&) = delete;
  RootHandle& operator=(const RootHandle&) = delete;
  ~RootHandle() { CloseNativeHandle(handle); }
  const NativeHandle handle;
};

struct RootState {
  explicit RootState(NativeHandle opened_root)
      : handle_(std::make_shared<const RootHandle>(opened_root)) {}

  // Snapshot the pinned handle. Null after Close(). The descriptor stays open
  // until the last snapshot is released, so in-flight operations drain against
  // the pinned object instead of racing a close.
  std::shared_ptr<const RootHandle> Acquire() {
    std::lock_guard<std::mutex> lock(mutex_);
    return handle_;
  }

  void Close() {
    std::shared_ptr<const RootHandle> released;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      released.swap(handle_);
    }  // ~RootHandle (and the close syscall) runs here, outside the lock
  }

 private:
  std::shared_ptr<const RootHandle> handle_;
  std::mutex mutex_;  // guards the pointer slot only; never held across I/O
};

class ListDirWorker final : public Napi::AsyncWorker {
 public:
  ListDirWorker(Napi::Env env, Napi::Promise::Deferred deferred,
                std::shared_ptr<RootState> state,
                std::vector<std::string> components, size_t max_entries)
      : Napi::AsyncWorker(env, "brainstrike:secure-fs:list-dir"),
        deferred_(deferred),
        state_(std::move(state)),
        components_(std::move(components)),
        max_entries_(max_entries) {}

  void Execute() override {
    const auto root = state_->Acquire();
    if (root) {
      succeeded_ = ListDirectory(root->handle, components_, max_entries_, &entries_, &inspected_,
                                 &truncated_);
    }
  }

  void OnOK() override {
    if (!succeeded_) {
      deferred_.Resolve(Env().Null());
      return;
    }
    deferred_.Resolve(BuildListResult(Env(), entries_, inspected_, truncated_));
  }

  void OnError(const Napi::Error& error) override { deferred_.Reject(error.Value()); }

 private:
  Napi::Promise::Deferred deferred_;
  std::shared_ptr<RootState> state_;
  std::vector<std::string> components_;
  size_t max_entries_;
  std::vector<DirEntry> entries_;
  size_t inspected_ = 0;
  bool truncated_ = false;
  bool succeeded_ = false;
};

class ReadFileWorker final : public Napi::AsyncWorker {
 public:
  ReadFileWorker(Napi::Env env, Napi::Promise::Deferred deferred,
                 std::shared_ptr<RootState> state,
                 std::vector<std::string> components, size_t max_bytes)
      : Napi::AsyncWorker(env, "brainstrike:secure-fs:read-file"),
        deferred_(deferred),
        state_(std::move(state)),
        components_(std::move(components)),
        max_bytes_(max_bytes) {}

  void Execute() override {
    const auto root = state_->Acquire();
    if (root) {
      status_ = ReadRelativeFile(root->handle, components_, max_bytes_, &content_);
    }
  }

  void OnOK() override { deferred_.Resolve(BuildReadResult(Env(), status_, content_)); }

  void OnError(const Napi::Error& error) override { deferred_.Reject(error.Value()); }

 private:
  Napi::Promise::Deferred deferred_;
  std::shared_ptr<RootState> state_;
  std::vector<std::string> components_;
  size_t max_bytes_;
  std::vector<uint8_t> content_;
  ReadStatus status_ = ReadStatus::kUnreadable;
};

class PrivateFileWorker final : public Napi::AsyncWorker {
 public:
  PrivateFileWorker(Napi::Env env, Napi::Promise::Deferred deferred,
                    std::shared_ptr<const RootHandle> root, std::vector<std::string> components,
                    bool write, std::vector<uint8_t> content = {})
      : Napi::AsyncWorker(env, "brainstrike:secure-fs:private-file"),
        deferred_(deferred),
        root_(std::move(root)),
        components_(std::move(components)),
        write_(write),
        content_(std::move(content)) {}
  void Execute() override {
    try {
      if (write_) {
        const auto failure = WritePrivateRelativeFile(root_->handle, components_, content_);
        if (!failure.empty()) SetError(failure);
      } else {
        status_ = ReadPrivateRelativeFile(root_->handle, components_, &content_);
      }
    } catch (const std::exception&) {
      SetError("Private file operation failed");
    }
    // Release the operation's pinned root before its Promise settles.
    root_.reset();
  }
  void OnOK() override {
    if (write_)
      deferred_.Resolve(Env().Undefined());
    else
      deferred_.Resolve(BuildReadResult(Env(), status_, content_));
  }
  void OnError(const Napi::Error& error) override {
    error.Value().Set("code", "ERR_PRIVATE_FILE_OPERATION");
    deferred_.Reject(error.Value());
  }

 private:
  Napi::Promise::Deferred deferred_;
  std::shared_ptr<const RootHandle> root_;
  std::vector<std::string> components_;
  bool write_;
  std::vector<uint8_t> content_;
  ReadStatus status_ = ReadStatus::kUnreadable;
};

class SecureRoot : public Napi::ObjectWrap<SecureRoot> {
 public:
  static Napi::Object Init(Napi::Env env, Napi::Object exports) {
    const Napi::Function constructor =
        DefineClass(env, "SecureRoot",
                    {InstanceMethod("close", &SecureRoot::Close),
                     InstanceMethod("listDir", &SecureRoot::ListDir),
                     InstanceMethod("listDirAsync", &SecureRoot::ListDirAsync),
                     InstanceMethod("readFile", &SecureRoot::ReadFile),
                     InstanceMethod("readFileAsync", &SecureRoot::ReadFileAsync),
                     InstanceMethod("readPrivateFileAsync", &SecureRoot::ReadPrivateFileAsync),
                     InstanceMethod("writePrivateFileAsync", &SecureRoot::WritePrivateFileAsync),
                     InstanceMethod("canonicalPath", &SecureRoot::CanonicalPath)});
    exports.Set("SecureRoot", constructor);
    return exports;
  }

  explicit SecureRoot(const Napi::CallbackInfo& info) : Napi::ObjectWrap<SecureRoot>(info) {
    if (info.Length() != 1 || !info[0].IsString()) {
      Napi::TypeError::New(info.Env(), "SecureRoot requires one absolute root path")
          .ThrowAsJavaScriptException();
      return;
    }
    bool missing = false;
    const NativeHandle root = OpenAbsoluteDirectory(info[0].As<Napi::String>().Utf8Value(), &missing);
    if (root == kInvalidHandle) {
      const auto error = Napi::Error::New(info.Env(), "Failed to open secure filesystem root");
      error.Value().Set("code", missing ? "ENOENT" : "ERR_SECURE_FS_ROOT");
      error.ThrowAsJavaScriptException();
      return;
    }
    canonical_path_ = DeriveCanonicalPath(root);
    if (canonical_path_.empty()) {
      CloseNativeHandle(root);
      Napi::Error::New(info.Env(),
                       "Failed to derive canonical identity from the opened root handle")
          .ThrowAsJavaScriptException();
      return;
    }
    state_ = std::make_shared<RootState>(root);
  }

  ~SecureRoot() override = default;

 private:
  Napi::Value CanonicalPath(const Napi::CallbackInfo& info) {
    return Napi::String::New(info.Env(), canonical_path_);
  }

  Napi::Value Close(const Napi::CallbackInfo& info) {
    if (state_) {
      state_->Close();
    }
    return info.Env().Undefined();
  }

  Napi::Value ListDir(const Napi::CallbackInfo& info) {
    const Napi::Env env = info.Env();
    if (!state_ || info.Length() != 2 || !info[0].IsString() ||
        !info[1].IsNumber()) {
      return env.Null();
    }
    const double requested_limit = info[1].As<Napi::Number>().DoubleValue();
    if (!IsWholeNumberInRange(requested_limit, 1, 10'000)) {
      return env.Null();
    }
    bool valid = false;
    const auto components = SplitRelativePath(info[0].As<Napi::String>().Utf8Value(), &valid);
    std::vector<DirEntry> entries;
    size_t inspected = 0;
    bool truncated = false;
    const auto root = state_->Acquire();
    if (!valid || !root ||
        !ListDirectory(root->handle, components, static_cast<size_t>(requested_limit), &entries,
                       &inspected, &truncated)) {
      return env.Null();
    }
    return BuildListResult(env, entries, inspected, truncated);
  }

  Napi::Value ListDirAsync(const Napi::CallbackInfo& info) {
    const Napi::Env env = info.Env();
    const auto deferred = Napi::Promise::Deferred::New(env);
    if (!state_ || info.Length() != 2 || !info[0].IsString() ||
        !info[1].IsNumber()) {
      deferred.Resolve(env.Null());
      return deferred.Promise();
    }
    const double requested_limit = info[1].As<Napi::Number>().DoubleValue();
    bool valid = false;
    auto components = SplitRelativePath(info[0].As<Napi::String>().Utf8Value(), &valid);
    if (!valid || !IsWholeNumberInRange(requested_limit, 1, 10'000)) {
      deferred.Resolve(env.Null());
      return deferred.Promise();
    }
    (new ListDirWorker(env, deferred, state_, std::move(components),
                       static_cast<size_t>(requested_limit)))
        ->Queue();
    return deferred.Promise();
  }

  Napi::Value ReadFile(const Napi::CallbackInfo& info) {
    const Napi::Env env = info.Env();
    Napi::Object result = Napi::Object::New(env);
    if (!state_ || info.Length() != 2 || !info[0].IsString() ||
        !info[1].IsNumber()) {
      result.Set("status", "unreadable");
      return result;
    }
    const double requested_max = info[1].As<Napi::Number>().DoubleValue();
    if (!IsWholeNumberInRange(requested_max, 0, 16 * 1024 * 1024)) {
      result.Set("status", "unreadable");
      return result;
    }
    bool valid = false;
    const auto components = SplitRelativePath(info[0].As<Napi::String>().Utf8Value(), &valid);
    std::vector<uint8_t> content;
    const auto root = state_->Acquire();
    const ReadStatus status =
        valid && root
            ? ReadRelativeFile(root->handle, components, static_cast<size_t>(requested_max),
                               &content)
            : ReadStatus::kUnreadable;
    return BuildReadResult(env, status, content);
  }

  Napi::Value ReadFileAsync(const Napi::CallbackInfo& info) {
    const Napi::Env env = info.Env();
    const auto deferred = Napi::Promise::Deferred::New(env);
    if (!state_ || info.Length() != 2 || !info[0].IsString() ||
        !info[1].IsNumber()) {
      deferred.Resolve(BuildReadResult(env, ReadStatus::kUnreadable, {}));
      return deferred.Promise();
    }
    const double requested_max = info[1].As<Napi::Number>().DoubleValue();
    bool valid = false;
    auto components = SplitRelativePath(info[0].As<Napi::String>().Utf8Value(), &valid);
    if (!valid || !IsWholeNumberInRange(requested_max, 0, 16 * 1024 * 1024)) {
      deferred.Resolve(BuildReadResult(env, ReadStatus::kUnreadable, {}));
      return deferred.Promise();
    }
    (new ReadFileWorker(env, deferred, state_, std::move(components),
                        static_cast<size_t>(requested_max)))
        ->Queue();
    return deferred.Promise();
  }

  Napi::Value ReadPrivateFileAsync(const Napi::CallbackInfo& info) {
    return PrivateOperation(info, false);
  }

  Napi::Value WritePrivateFileAsync(const Napi::CallbackInfo& info) {
    return PrivateOperation(info, true);
  }

  Napi::Value PrivateOperation(const Napi::CallbackInfo& info, bool write) {
    const auto env = info.Env();
    const auto deferred = Napi::Promise::Deferred::New(env);
    bool valid = false;
    std::vector<std::string> components;
    if (info.Length() == (write ? 2u : 1u) && info[0].IsString() &&
        (!write || info[1].IsBuffer())) {
      components = SplitRelativePath(info[0].As<Napi::String>().Utf8Value(), &valid);
    }
    const auto root = state_ ? state_->Acquire() : nullptr;
    if (!valid || components.empty() || !root) {
      const auto error = Napi::Error::New(env, "Private file path or capability is unavailable");
      error.Value().Set("code", "ERR_PRIVATE_FILE_OPERATION");
      deferred.Reject(error.Value());
      return deferred.Promise();
    }
    std::vector<uint8_t> content;
    if (write) {
      const auto buffer = info[1].As<Napi::Buffer<uint8_t>>();
      content.assign(buffer.Data(), buffer.Data() + buffer.Length());
    }
    (new PrivateFileWorker(env, deferred, root, std::move(components), write, std::move(content)))
        ->Queue();
    return deferred.Promise();
  }

  std::shared_ptr<RootState> state_;
  std::string canonical_path_;
};

// flock(2) LOCK_EX | LOCK_NB on a caller-owned descriptor: true when this open
// file description now holds the exclusive lock, false when another holds it.
// The lock belongs to the open file description, so every process that
// inherited the descriptor keeps it until the last one closes or exits.
// POSIX only: Windows byte-range locks die with the locking process.
Napi::Value TryExclusiveFlock(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  if (info.Length() != 1 || !info[0].IsNumber() ||
      !IsWholeNumberInRange(info[0].As<Napi::Number>().DoubleValue(), 0, INT_MAX)) {
    throw Napi::TypeError::New(env, "tryExclusiveFlock expects one file descriptor");
  }
#ifdef _WIN32
  const auto error = Napi::Error::New(env, "flock is not available on Windows");
  error.Value().Set("code", "ENOTSUP");
  throw error;
#else
  const int fd = static_cast<int>(info[0].As<Napi::Number>().DoubleValue());
  for (;;) {
    if (flock(fd, LOCK_EX | LOCK_NB) == 0) {
      return Napi::Boolean::New(env, true);
    }
    const int code = errno;
    if (code == EINTR) {
      continue;
    }
    if (code == EWOULDBLOCK) {
      return Napi::Boolean::New(env, false);
    }
    const auto error = Napi::Error::New(env, std::string("flock failed: ") + std::strerror(code));
    error.Value().Set("errno", Napi::Number::New(env, code));
    throw error;
  }
#endif
}


// Caller owns both paths and performs its authority checks before each call.
// This primitive performs one atomic replacement, with no deletion or retry.
Napi::Value ReplaceFileSync(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  if (info.Length() != 2 || !info[0].IsString() || !info[1].IsString()) {
    throw Napi::TypeError::New(env, "replaceFileSync expects source and target paths");
  }
#ifdef _WIN32
  const auto source = info[0].As<Napi::String>().Utf8Value();
  const auto target = info[1].As<Napi::String>().Utf8Value();
  const auto source_split = source.find_last_of("/\\");
  const auto target_split = target.find_last_of("/\\");
  if (source.find('\0') != std::string::npos || target.find('\0') != std::string::npos ||
      source_split == std::string::npos || target_split == std::string::npos ||
      source.substr(0, source_split) != target.substr(0, target_split) ||
      source == target || target_split + 1 == target.size()) {
    throw Napi::TypeError::New(env, "replaceFileSync requires distinct files in one directory");
  }
  const auto fail = [&](DWORD code) {
    const auto error = Napi::Error::New(env, "Atomic file replacement failed (Windows " +
                                           std::to_string(code) + ")");
    const char* name = "EIO";
    if (code == ERROR_ACCESS_DENIED) name = "EACCES";
    else if (code == ERROR_SHARING_VIOLATION || code == ERROR_LOCK_VIOLATION) name = "EBUSY";
    else if (code == ERROR_FILE_NOT_FOUND || code == ERROR_PATH_NOT_FOUND) name = "ENOENT";
    else if (code == ERROR_NOT_SUPPORTED || code == ERROR_INVALID_PARAMETER) name = "ENOTSUP";
    error.Value().Set("code", name);
    error.Value().Set("win32Code", Napi::Number::New(env, code));
    throw error;
  };
  const auto wide_source = Utf8ToWide(source);
  PrivateHandle file(CreateFileW(wide_source.c_str(), DELETE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
      FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  if (file.Get() == kInvalidHandle) fail(GetLastError());
  const auto wide_parent = Utf8ToWide(target.substr(0, target_split));
  PrivateHandle parent(CreateFileW(wide_parent.c_str(), FILE_LIST_DIRECTORY | SYNCHRONIZE,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  if (parent.Get() == kInvalidHandle) fail(GetLastError());
  if (!ReplacePrivateTemporary(file.Get(), parent.Get(), "", target.substr(target_split + 1), true)) {
    fail(GetLastError());
  }
  return env.Undefined();
#else
  const auto error = Napi::Error::New(env, "Windows replacement is unavailable on this platform");
  error.Value().Set("code", "ENOTSUP");
  throw error;
#endif
}

Napi::Object InitModule(Napi::Env env, Napi::Object exports) {
  exports.Set("tryExclusiveFlock", Napi::Function::New(env, TryExclusiveFlock));
  exports.Set("replaceFileSync", Napi::Function::New(env, ReplaceFileSync));
  return SecureRoot::Init(env, exports);
}

NODE_API_MODULE(secure_fs_native, InitModule)

}  // namespace
