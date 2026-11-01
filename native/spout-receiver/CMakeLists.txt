cmake_minimum_required(VERSION 3.24)
project(CueDeckSpoutReceiver LANGUAGES CXX)

if(NOT WIN32)
  message(FATAL_ERROR "CueDeck Spout Receiver is a Windows-only test utility")
endif()

set(SPOUT2_ROOT "" CACHE PATH "Path to official Spout2 2.007.018 source")
if(NOT EXISTS "${SPOUT2_ROOT}/SPOUTSDK/SpoutDirectX/SpoutDX/SpoutDX.cpp")
  message(FATAL_ERROR "Set -DSPOUT2_ROOT to the pinned Spout2 source tree")
endif()

set(SPOUT_SDK "${SPOUT2_ROOT}/SPOUTSDK")
set(SPOUT_DX "${SPOUT_SDK}/SpoutDirectX/SpoutDX")
set(SPOUT_GL "${SPOUT_SDK}/SpoutGL")
file(GLOB SPOUT_GL_SOURCES CONFIGURE_DEPENDS "${SPOUT_GL}/*.cpp")

add_executable(CueDeckSpoutReceiver WIN32
  src/main.cpp
  "${SPOUT_DX}/SpoutDX.cpp"
  ${SPOUT_GL_SOURCES}
)
target_include_directories(CueDeckSpoutReceiver PRIVATE
  "${SPOUT_SDK}"
  "${SPOUT_DX}"
  "${SPOUT_GL}"
)
target_compile_features(CueDeckSpoutReceiver PRIVATE cxx_std_17)
target_compile_definitions(CueDeckSpoutReceiver PRIVATE NOMINMAX _CRT_SECURE_NO_WARNINGS)
set(D3DCOMPILER_LIBRARY d3dcompiler)
if(MINGW)
  # SpoutCopy contains SSSE3 intrinsics; keep the option local to that source.
  set_source_files_properties("${SPOUT_GL}/SpoutCopy.cpp" PROPERTIES COMPILE_OPTIONS "-mssse3")
  # The MinGW import library is named after the Windows system DLL.
  set(D3DCOMPILER_LIBRARY d3dcompiler_47)
  target_link_options(CueDeckSpoutReceiver PRIVATE -municode -Wl,--subsystem,windows)
endif()
target_link_libraries(CueDeckSpoutReceiver PRIVATE
  d3d11 dxgi ${D3DCOMPILER_LIBRARY} opengl32 shell32 user32 gdi32
  winmm version comctl32
)

add_library(CueDeckSpoutSenderAdapter STATIC
  sender-adapter/SpoutSenderAdapter.cpp
)
target_include_directories(CueDeckSpoutSenderAdapter PRIVATE
  "${SPOUT_SDK}" "${SPOUT_DX}" "${SPOUT_GL}" sender-adapter
)
target_compile_features(CueDeckSpoutSenderAdapter PRIVATE cxx_std_17)
target_compile_definitions(CueDeckSpoutSenderAdapter PRIVATE NOMINMAX _CRT_SECURE_NO_WARNINGS)
