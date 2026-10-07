{
  "targets": [
    {
      "target_name": "secure_fs_native",
      "sources": ["src/secure_fs.cc"],
      "conditions": [["OS=='win'", { "libraries": ["Advapi32.lib"] }]],
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
        }
      }
    }
  ]
}
