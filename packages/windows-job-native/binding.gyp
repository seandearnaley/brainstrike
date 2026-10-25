{
  "targets": [
    {
      "target_name": "windows_job_native",
      "sources": ["src/windows_job.cc"],
      "include_dirs": ["<!@(node -p \"require('node-addon-api').include\")"],
      "defines": ["NAPI_CPP_EXCEPTIONS"],
      "cflags_cc": ["-Wall", "-Wextra", "-Werror"],
      "cflags_cc!": ["-fno-exceptions"],
      "xcode_settings": {
        "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
        "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
        "WARNING_CFLAGS": ["-Wall", "-Wextra", "-Werror"]
      },
      "msvs_settings": {
        "VCCLCompilerTool": {
          "ExceptionHandling": 1,
          "AdditionalOptions": ["/std:c++17"],
          "TreatWarningAsError": "true",
          "WarningLevel": 4
        },
        # No linker PDB: nothing reads one, and concurrent native links sharing
        # mspdbsrv failed on Windows CI (LNK1318, RPC server unavailable).
        "VCLinkerTool": { "GenerateDebugInformation": "false" }
      }
    }
  ]
}
