// Test-only witness for the command Job tests: pins processes by handle and answers on stdout,
// one JSON line per command, independently of the add-on under test.
//
//   process_observer.exe <pid>[,<pid>...]
//
// Replies `{"event":"pinned",...}` once every target is pinned, then reads one command per line:
//   check | join          wait 0 ms | 5000 ms on each pinned process; report waits and exit codes
//   deny <mask>           give the first pinned process a DACL that denies <mask> to Everyone
//   restrict <pid>        remove SeDebugPrivilege from that process's token
//   release               exit 0
#include <windows.h>

#include <sddl.h>

#include <cstdio>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

struct Pinned {
  DWORD pid;
  HANDLE handle;
  unsigned long long start;
};

[[noreturn]] void Fail(const char* operation) {
  throw std::runtime_error(std::string(operation) + " failed with Windows error " +
                           std::to_string(GetLastError()));
}

std::string Identities(const std::vector<Pinned>& pinned) {
  std::string json = "[";
  for (size_t i = 0; i < pinned.size(); ++i) {
    if (i > 0) json += ",";
    json += "{\"pid\":" + std::to_string(pinned[i].pid) + ",\"start\":\"" +
            std::to_string(pinned[i].start) + "\"}";
  }
  return json + "]";
}

void Reply(const std::string& line) {
  std::cout << line << "\n" << std::flush;
}

Pinned Pin(DWORD pid) {
  const HANDLE handle = OpenProcess(SYNCHRONIZE | WRITE_DAC | PROCESS_QUERY_LIMITED_INFORMATION,
                                    FALSE, pid);
  if (handle == nullptr) Fail("OpenProcess");
  FILETIME creation{}, exit{}, kernel{}, user{};
  if (!GetProcessTimes(handle, &creation, &exit, &kernel, &user)) Fail("GetProcessTimes");
  ULARGE_INTEGER start{};
  start.LowPart = creation.dwLowDateTime;
  start.HighPart = creation.dwHighDateTime;
  return Pinned{pid, handle, start.QuadPart};
}

void Deny(const Pinned& target, const std::string& mask) {
  std::wstring sddl = L"D:(D;;";
  for (const char c : mask) sddl.push_back(static_cast<wchar_t>(c));
  sddl += L";;;WD)(A;;GA;;;WD)";
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1,
                                                            &descriptor, nullptr)) {
    Fail("ConvertStringSecurityDescriptorToSecurityDescriptorW");
  }
  const BOOL set = SetKernelObjectSecurity(target.handle, DACL_SECURITY_INFORMATION, descriptor);
  const DWORD error = GetLastError();
  LocalFree(descriptor);
  if (!set) {
    SetLastError(error);
    Fail("SetKernelObjectSecurity");
  }
}

// The privilege's attributes in the token, or -1 when the token does not hold it.
long long PrivilegeAttributes(HANDLE token, const LUID& luid) {
  DWORD size = 0;
  GetTokenInformation(token, TokenPrivileges, nullptr, 0, &size);
  std::vector<unsigned char> buffer(size);
  if (!GetTokenInformation(token, TokenPrivileges, buffer.data(), size, &size)) {
    Fail("GetTokenInformation");
  }
  const auto* privileges = reinterpret_cast<const TOKEN_PRIVILEGES*>(buffer.data());
  for (DWORD i = 0; i < privileges->PrivilegeCount; ++i) {
    const LUID_AND_ATTRIBUTES& entry = privileges->Privileges[i];
    if (entry.Luid.LowPart == luid.LowPart && entry.Luid.HighPart == luid.HighPart) {
      return entry.Attributes;
    }
  }
  return -1;
}

std::string RemoveDebugPrivilege(DWORD pid) {
  LUID luid{};
  if (!LookupPrivilegeValueW(nullptr, SE_DEBUG_NAME, &luid)) Fail("LookupPrivilegeValueW");
  const HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (process == nullptr) Fail("OpenProcess");
  HANDLE token = nullptr;
  if (!OpenProcessToken(process, TOKEN_QUERY | TOKEN_ADJUST_PRIVILEGES, &token)) {
    const DWORD error = GetLastError();
    CloseHandle(process);
    SetLastError(error);
    Fail("OpenProcessToken");
  }
  std::string prior;
  try {
    const long long attributes = PrivilegeAttributes(token, luid);
    if (attributes != -1) {
      TOKEN_PRIVILEGES removal{};
      removal.PrivilegeCount = 1;
      removal.Privileges[0].Luid = luid;
      removal.Privileges[0].Attributes = SE_PRIVILEGE_REMOVED;
      if (!AdjustTokenPrivileges(token, FALSE, &removal, 0, nullptr, nullptr) ||
          GetLastError() != ERROR_SUCCESS) {
        Fail("AdjustTokenPrivileges");
      }
    }
    if (PrivilegeAttributes(token, luid) != -1) {
      throw std::runtime_error("SeDebugPrivilege remains in the actor token.");
    }
    prior = attributes == -1 ? "absent"
                             : ((attributes & SE_PRIVILEGE_ENABLED) != 0 ? "enabled" : "disabled");
  } catch (...) {
    CloseHandle(token);
    CloseHandle(process);
    throw;
  }
  CloseHandle(token);
  CloseHandle(process);
  return prior;
}

std::string WaitAll(const std::vector<Pinned>& pinned, const std::string& command) {
  const DWORD milliseconds = command == "join" ? 5000 : 0;
  std::string waits = "[";
  std::string codes = "[";
  for (size_t i = 0; i < pinned.size(); ++i) {
    if (i > 0) waits += ",";
    waits += std::to_string(WaitForSingleObject(pinned[i].handle, milliseconds));
  }
  for (size_t i = 0; i < pinned.size(); ++i) {
    DWORD code = 0;
    if (!GetExitCodeProcess(pinned[i].handle, &code)) Fail("GetExitCodeProcess");
    if (i > 0) codes += ",";
    codes += std::to_string(code);
  }
  return "{\"event\":\"" + command + "\",\"waits\":" + waits + "],\"codes\":" + codes +
         "],\"identities\":" + Identities(pinned) + "}";
}

int Observe(const std::string& targets) {
  std::vector<Pinned> pinned;
  try {
    size_t begin = 0;
    while (begin <= targets.size()) {
      const size_t end = targets.find(',', begin);
      const std::string pid =
          targets.substr(begin, end == std::string::npos ? std::string::npos : end - begin);
      pinned.push_back(Pin(static_cast<DWORD>(std::stoul(pid))));
      if (end == std::string::npos) break;
      begin = end + 1;
    }
    Reply("{\"event\":\"pinned\",\"identities\":" + Identities(pinned) + "}");
    std::string line;
    while (std::getline(std::cin, line)) {
      if (!line.empty() && line.back() == '\r') line.pop_back();
      if (line == "release") break;
      if (line.rfind("deny ", 0) == 0) {
        Deny(pinned.at(0), line.substr(5));
        Reply("{\"event\":\"denied\",\"identities\":" + Identities(pinned) + "}");
      } else if (line.rfind("restrict ", 0) == 0) {
        const DWORD pid = static_cast<DWORD>(std::stoul(line.substr(9)));
        const std::string prior = RemoveDebugPrivilege(pid);
        Reply("{\"event\":\"restricted\",\"pid\":" + std::to_string(pid) +
              ",\"debugPrivilege\":\"" + prior + "\"}");
      } else if (line == "check" || line == "join") {
        Reply(WaitAll(pinned, line));
      } else {
        throw std::runtime_error("Unexpected observer command: " + line);
      }
    }
  } catch (const std::exception& error) {
    std::cerr << error.what() << "\n";
    for (const Pinned& entry : pinned) CloseHandle(entry.handle);
    return 1;
  }
  for (const Pinned& entry : pinned) CloseHandle(entry.handle);
  return 0;
}

}  // namespace

int main(int argc, char** argv) {
  if (argc != 2) {
    std::cerr << "usage: process_observer <pid>[,<pid>...]\n";
    return 2;
  }
  return Observe(argv[1]);
}
