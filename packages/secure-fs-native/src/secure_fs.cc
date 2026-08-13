#include <napi.h>

#include <algorithm>
#include <cerrno>
#include <climits>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <memory>
#include <mutex>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <Windows.h>
#include <winternl.h>
#ifndef FILE_DIRECTORY_FILE
#define FILE_DIRECTORY_FILE 0x00000001
#endif
#ifndef FILE_OPEN
#define FILE_OPEN 0x00000001
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
                                   bool directory, bool* not_found = nullptr) {
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
      &result, access, &attributes, &status_block, nullptr, FILE_ATTRIBUTE_NORMAL,
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

NativeHandle OpenAbsoluteDirectory(const std::string& utf8_path) {
  const std::wstring path = Utf8ToWide(utf8_path);
  if (path.empty()) {
    return kInvalidHandle;
  }
  const NativeHandle handle = CreateFileW(
      path.c_str(),
      FILE_LIST_DIRECTORY | FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS, nullptr);
  if (handle == kInvalidHandle) {
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

bool ListDirectory(NativeHandle root, const std::vector<std::string>& components,
                   size_t max_entries, std::vector<DirEntry>* entries, size_t* inspected,
                   bool* truncated) {
  const bool borrowed_root = components.empty();
  NativeHandle directory = borrowed_root ? root : OpenRelativeDirectory(root, components);
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
      if (!borrowed_root) {
        CloseNativeHandle(directory);
      }
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
          if (!borrowed_root) {
            CloseNativeHandle(directory);
          }
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

NativeHandle OpenAbsoluteDirectory(const std::string& path) {
  if (path.empty() || path.front() != '/' || path.find('\0') != std::string::npos) {
    return kInvalidHandle;
  }
  // Root establishment follows symlinks by design: the path comes from the
  // trusted folder picker or persisted store, never from repository content.
  // Descendant resolution below this handle remains strictly no-follow.
  return open(path.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC);
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
      return buffer;
    }
    buffer.resize(buffer.size() * 2);
  }
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

struct RootState {
  explicit RootState(NativeHandle opened_root) : root(opened_root) {}

  ~RootState() { CloseNativeHandle(root); }

  void Close() {
    std::lock_guard<std::mutex> lock(mutex);
    CloseNativeHandle(root);
    root = kInvalidHandle;
  }

  NativeHandle root;
  std::mutex mutex;
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
    std::lock_guard<std::mutex> lock(state_->mutex);
    if (state_->root != kInvalidHandle) {
      succeeded_ = ListDirectory(state_->root, components_, max_entries_, &entries_, &inspected_,
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
    std::lock_guard<std::mutex> lock(state_->mutex);
    if (state_->root != kInvalidHandle) {
      status_ = ReadRelativeFile(state_->root, components_, max_bytes_, &content_);
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

class SecureRoot : public Napi::ObjectWrap<SecureRoot> {
 public:
  static Napi::Object Init(Napi::Env env, Napi::Object exports) {
    const Napi::Function constructor = DefineClass(
        env, "SecureRoot",
        {InstanceMethod("close", &SecureRoot::Close), InstanceMethod("listDir", &SecureRoot::ListDir),
         InstanceMethod("listDirAsync", &SecureRoot::ListDirAsync),
         InstanceMethod("readFile", &SecureRoot::ReadFile),
         InstanceMethod("readFileAsync", &SecureRoot::ReadFileAsync),
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
    const NativeHandle root = OpenAbsoluteDirectory(info[0].As<Napi::String>().Utf8Value());
    if (root == kInvalidHandle) {
      Napi::Error::New(info.Env(), "Failed to open secure filesystem root")
          .ThrowAsJavaScriptException();
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
    std::lock_guard<std::mutex> lock(state_->mutex);
    if (!valid || state_->root == kInvalidHandle ||
        !ListDirectory(state_->root, components, static_cast<size_t>(requested_limit), &entries,
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
    std::lock_guard<std::mutex> lock(state_->mutex);
    const ReadStatus status =
        valid && state_->root != kInvalidHandle
            ? ReadRelativeFile(state_->root, components, static_cast<size_t>(requested_max),
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

  std::shared_ptr<RootState> state_;
  std::string canonical_path_;
};

Napi::Object InitModule(Napi::Env env, Napi::Object exports) {
  return SecureRoot::Init(env, exports);
}

NODE_API_MODULE(secure_fs_native, InitModule)

}  // namespace
