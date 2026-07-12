#include <napi.h>

#include <algorithm>
#include <cerrno>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <string>
#include <string_view>
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
};

std::vector<std::string> SplitRelativePath(const std::string& path, bool* valid) {
  *valid = false;
  if (path.empty() || path == ".") {
    *valid = true;
    return {};
  }
  if (path.front() == '/' || path.front() == '\\' || path.find('\0') != std::string::npos) {
    return {};
  }

  std::vector<std::string> components;
  std::string current;
  for (const char character : path) {
    if (character == '/' || character == '\\') {
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
constexpr NativeHandle kInvalidHandle = INVALID_HANDLE_VALUE;

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
                                   bool directory) {
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
    CloseNativeHandle(result);
    return kInvalidHandle;
  }
  return result;
}

bool ParseWindowsAbsoluteRoot(const std::wstring& input, std::wstring* prefix,
                              std::vector<std::wstring>* components) {
  std::wstring path = input;
  std::replace(path.begin(), path.end(), L'/', L'\\');
  size_t cursor = 0;
  if (path.rfind(L"\\\\?\\UNC\\", 0) == 0 || path.rfind(L"\\\\", 0) == 0) {
    cursor = path.rfind(L"\\\\?\\UNC\\", 0) == 0 ? 8 : 2;
    const size_t server_end = path.find(L'\\', cursor);
    const size_t share_end = server_end == std::wstring::npos
                                 ? std::wstring::npos
                                 : path.find(L'\\', server_end + 1);
    if (server_end == std::wstring::npos) {
      return false;
    }
    const size_t root_end = share_end == std::wstring::npos ? path.size() : share_end + 1;
    *prefix = path.substr(0, root_end);
    cursor = root_end;
  } else {
    const size_t drive_offset = path.rfind(L"\\\\?\\", 0) == 0 ? 4 : 0;
    if (path.size() < drive_offset + 3 || path[drive_offset + 1] != L':' ||
        path[drive_offset + 2] != L'\\') {
      return false;
    }
    cursor = drive_offset + 3;
    *prefix = path.substr(0, cursor);
  }

  std::wstring current;
  for (; cursor <= path.size(); ++cursor) {
    if (cursor == path.size() || path[cursor] == L'\\') {
      if (!current.empty()) {
        components->push_back(current);
        current.clear();
      }
      continue;
    }
    current.push_back(path[cursor]);
  }
  return true;
}

NativeHandle OpenAbsoluteDirectory(const std::string& utf8_path) {
  const std::wstring path = Utf8ToWide(utf8_path);
  std::wstring prefix;
  std::vector<std::wstring> components;
  if (path.empty() || !ParseWindowsAbsoluteRoot(path, &prefix, &components)) {
    return kInvalidHandle;
  }
  NativeHandle current = CreateFileW(
      prefix.c_str(), FILE_LIST_DIRECTORY | FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  if (current == kInvalidHandle || IsReparsePoint(current)) {
    CloseNativeHandle(current);
    return kInvalidHandle;
  }
  for (const auto& component : components) {
    NativeHandle next = OpenRelativeComponent(current, component, true);
    CloseNativeHandle(current);
    if (next == kInvalidHandle) {
      return kInvalidHandle;
    }
    current = next;
  }
  return current;
}

NativeHandle OpenRelativeDirectory(NativeHandle root,
                                   const std::vector<std::string>& components) {
  NativeHandle current = kInvalidHandle;
  if (!DuplicateHandle(GetCurrentProcess(), root, GetCurrentProcess(), &current, 0, FALSE,
                       DUPLICATE_SAME_ACCESS)) {
    return kInvalidHandle;
  }
  for (const auto& component : components) {
    const std::wstring wide_component = Utf8ToWide(component);
    NativeHandle next = OpenRelativeComponent(current, wide_component, true);
    CloseNativeHandle(current);
    if (next == kInvalidHandle) {
      return kInvalidHandle;
    }
    current = next;
  }
  return current;
}

bool ListDirectory(NativeHandle root, const std::vector<std::string>& components,
                   std::vector<DirEntry>* entries) {
  NativeHandle directory = OpenRelativeDirectory(root, components);
  if (directory == kInvalidHandle) {
    return false;
  }
  std::vector<std::byte> buffer(64 * 1024);
  bool restart = true;
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
      if (name != L"." && name != L".." &&
          (information->FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) == 0) {
        const std::string utf8_name = WideToUtf8(name.data(), name.size());
        if (!utf8_name.empty()) {
          const bool is_directory =
              (information->FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
          entries->push_back({utf8_name, is_directory, !is_directory});
        }
      }
      if (information->NextEntryOffset == 0) {
        break;
      }
      offset += information->NextEntryOffset;
    }
  }
}

enum class ReadStatus { kOk, kOversized, kUnreadable };

ReadStatus ReadRelativeFile(NativeHandle root, const std::vector<std::string>& components,
                            size_t max_bytes, std::vector<uint8_t>* content) {
  if (components.empty()) {
    return ReadStatus::kUnreadable;
  }
  std::vector<std::string> parent_components(components.begin(), components.end() - 1);
  NativeHandle parent = OpenRelativeDirectory(root, parent_components);
  if (parent == kInvalidHandle) {
    return ReadStatus::kUnreadable;
  }
  NativeHandle file = OpenRelativeComponent(parent, Utf8ToWide(components.back()), false);
  CloseNativeHandle(parent);
  if (file == kInvalidHandle) {
    return ReadStatus::kUnreadable;
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
  if (path.empty() || path.front() != '/') {
    return kInvalidHandle;
  }
  bool valid = false;
  const auto components = SplitRelativePath(path.substr(1), &valid);
  if (!valid) {
    return kInvalidHandle;
  }
  NativeHandle current = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (current == kInvalidHandle) {
    return kInvalidHandle;
  }
  for (const auto& component : components) {
    const NativeHandle next =
        openat(current, component.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    CloseNativeHandle(current);
    if (next == kInvalidHandle) {
      return kInvalidHandle;
    }
    current = next;
  }
  return current;
}

NativeHandle OpenRelativeDirectory(NativeHandle root,
                                   const std::vector<std::string>& components) {
  NativeHandle current = dup(root);
  if (current == kInvalidHandle) {
    return kInvalidHandle;
  }
  for (const auto& component : components) {
    const NativeHandle next =
        openat(current, component.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    CloseNativeHandle(current);
    if (next == kInvalidHandle) {
      return kInvalidHandle;
    }
    current = next;
  }
  return current;
}

bool ListDirectory(NativeHandle root, const std::vector<std::string>& components,
                   std::vector<DirEntry>* entries) {
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
    struct stat information {};
    if (fstatat(dirfd(directory), entry->d_name, &information, AT_SYMLINK_NOFOLLOW) != 0) {
      continue;
    }
    entries->push_back(
        {entry->d_name, S_ISDIR(information.st_mode), S_ISREG(information.st_mode)});
  }
  closedir(directory);
  return succeeded;
}

enum class ReadStatus { kOk, kOversized, kUnreadable };

ReadStatus ReadRelativeFile(NativeHandle root, const std::vector<std::string>& components,
                            size_t max_bytes, std::vector<uint8_t>* content) {
  if (components.empty()) {
    return ReadStatus::kUnreadable;
  }
  std::vector<std::string> parent_components(components.begin(), components.end() - 1);
  NativeHandle parent = OpenRelativeDirectory(root, parent_components);
  if (parent == kInvalidHandle) {
    return ReadStatus::kUnreadable;
  }
  const NativeHandle file =
      openat(parent, components.back().c_str(), O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  CloseNativeHandle(parent);
  if (file == kInvalidHandle) {
    return ReadStatus::kUnreadable;
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

class SecureRoot : public Napi::ObjectWrap<SecureRoot> {
 public:
  static Napi::Object Init(Napi::Env env, Napi::Object exports) {
    const Napi::Function constructor = DefineClass(
        env, "SecureRoot",
        {InstanceMethod("close", &SecureRoot::Close), InstanceMethod("listDir", &SecureRoot::ListDir),
         InstanceMethod("readFile", &SecureRoot::ReadFile)});
    exports.Set("SecureRoot", constructor);
    return exports;
  }

  explicit SecureRoot(const Napi::CallbackInfo& info)
      : Napi::ObjectWrap<SecureRoot>(info), root_(kInvalidHandle) {
    if (info.Length() != 1 || !info[0].IsString()) {
      Napi::TypeError::New(info.Env(), "SecureRoot requires one absolute root path")
          .ThrowAsJavaScriptException();
      return;
    }
    root_ = OpenAbsoluteDirectory(info[0].As<Napi::String>().Utf8Value());
    if (root_ == kInvalidHandle) {
      Napi::Error::New(info.Env(), "Failed to open secure filesystem root")
          .ThrowAsJavaScriptException();
    }
  }

  ~SecureRoot() override { CloseHandleIfOpen(); }

 private:
  void CloseHandleIfOpen() {
    CloseNativeHandle(root_);
    root_ = kInvalidHandle;
  }

  Napi::Value Close(const Napi::CallbackInfo& info) {
    CloseHandleIfOpen();
    return info.Env().Undefined();
  }

  Napi::Value ListDir(const Napi::CallbackInfo& info) {
    const Napi::Env env = info.Env();
    if (root_ == kInvalidHandle || info.Length() != 1 || !info[0].IsString()) {
      return env.Null();
    }
    bool valid = false;
    const auto components = SplitRelativePath(info[0].As<Napi::String>().Utf8Value(), &valid);
    std::vector<DirEntry> entries;
    if (!valid || !ListDirectory(root_, components, &entries)) {
      return env.Null();
    }
    const Napi::Array result = Napi::Array::New(env, entries.size());
    for (size_t index = 0; index < entries.size(); ++index) {
      Napi::Object entry = Napi::Object::New(env);
      entry.Set("name", entries[index].name);
      entry.Set("isDirectory", entries[index].is_directory);
      entry.Set("isFile", entries[index].is_file);
      result.Set(index, entry);
    }
    return result;
  }

  Napi::Value ReadFile(const Napi::CallbackInfo& info) {
    const Napi::Env env = info.Env();
    Napi::Object result = Napi::Object::New(env);
    if (root_ == kInvalidHandle || info.Length() != 2 || !info[0].IsString() ||
        !info[1].IsNumber()) {
      result.Set("status", "unreadable");
      return result;
    }
    const double requested_max = info[1].As<Napi::Number>().DoubleValue();
    if (requested_max < 0 || requested_max > 16 * 1024 * 1024 ||
        requested_max != static_cast<size_t>(requested_max)) {
      result.Set("status", "unreadable");
      return result;
    }
    bool valid = false;
    const auto components = SplitRelativePath(info[0].As<Napi::String>().Utf8Value(), &valid);
    std::vector<uint8_t> content;
    const ReadStatus status =
        valid ? ReadRelativeFile(root_, components, static_cast<size_t>(requested_max), &content)
              : ReadStatus::kUnreadable;
    if (status == ReadStatus::kOversized) {
      result.Set("status", "oversized");
      return result;
    }
    if (status != ReadStatus::kOk) {
      result.Set("status", "unreadable");
      return result;
    }
    result.Set("status", "ok");
    result.Set("content", Napi::Buffer<uint8_t>::Copy(env, content.data(), content.size()));
    return result;
  }

  NativeHandle root_;
};

Napi::Object InitModule(Napi::Env env, Napi::Object exports) {
  return SecureRoot::Init(env, exports);
}

NODE_API_MODULE(secure_fs_native, InitModule)

}  // namespace
