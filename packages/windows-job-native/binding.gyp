{
  "targets": [
    {
      "target_name": "windows_job_native",
      "sources": ["src/windows_job.cc"],
      "include_dirs": ["<!@(node -p \"require('node-addon-api').include\")"],
      "defines": ["NAPI_CPP_EXCEPTIONS", "NODE_API_SWALLOW_UNTHROWABLE_EXCEPTIONS"],
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
  ],
  "conditions": [
    [
      "OS=='win'",
      {
        "targets": [
          {
            # The command Job tests' independent witness (test/process_observer.cc).
            "target_name": "process_observer",
            "type": "executable",
            "win_delay_load_hook": "false",
            "sources": ["test/process_observer.cc"],
            "defines": ["UNICODE", "_UNICODE"],
            "msvs_settings": {
              "VCCLCompilerTool": {
                "ExceptionHandling": 1,
                "WarnAsError": "true",
                "WarningLevel": 4
              },
              "VCLinkerTool": { "GenerateDebugInformation": "false" }
            }
          }
        ]
      }
    ]
  ]
}
