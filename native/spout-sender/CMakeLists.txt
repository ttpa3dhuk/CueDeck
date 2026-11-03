cmake_minimum_required(VERSION 3.24)
project(CueDeckSpoutGpuNative LANGUAGES CXX)

if(NOT WIN32)
  message(FATAL_ERROR "The Spout GPU sender is Windows-only")
endif()
set(SPOUT2_ROOT "" CACHE PATH "Pinned official Spout2 2.007.018 source")
if(NOT EXISTS "${SPOUT2_ROOT}/SPOUTSDK/SpoutDirectX/SpoutDX/SpoutDX.cpp")
  message(FATAL_ERROR "Set SPOUT2_ROOT to the pinned Spout2 source tree")
endif()

set(SPOUT_SDK "${SPOUT2_ROOT}/SPOUTSDK")
set(SPOUT_DX "${SPOUT_SDK}/SpoutDirectX/SpoutDX")
set(SPOUT_GL "${SPOUT_SDK}/SpoutGL")
file(GLOB SPOUT_GL_SOURCES CONFIGURE_DEPENDS "${SPOUT_GL}/*.cpp")

add_library(cuedeck_spout_gpu SHARED
  src/spout_gpu_native.cpp
  "${SPOUT_DX}/SpoutDX.cpp"
  ${SPOUT_GL_SOURCES}
)
set_target_properties(cuedeck_spout_gpu PROPERTIES
  PREFIX "" OUTPUT_NAME "cuedeck_spout_gpu"
  RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}"
  RUNTIME_OUTPUT_DIRECTORY_RELEASE "${CMAKE_CURRENT_BINARY_DIR}"
  RUNTIME_OUTPUT_DIRECTORY_DEBUG "${CMAKE_CURRENT_BINARY_DIR}"
  RUNTIME_OUTPUT_DIRECTORY_RELWITHDEBINFO "${CMAKE_CURRENT_BINARY_DIR}")
target_include_directories(cuedeck_spout_gpu PRIVATE
  "${SPOUT_SDK}" "${SPOUT_DX}" "${SPOUT_GL}")
target_compile_features(cuedeck_spout_gpu PRIVATE cxx_std_17)
target_compile_definitions(cuedeck_spout_gpu PRIVATE NOMINMAX _CRT_SECURE_NO_WARNINGS)
set(D3DCOMPILER_LIBRARY d3dcompiler)
if(MINGW)
  set_source_files_properties("${SPOUT_GL}/SpoutCopy.cpp" PROPERTIES COMPILE_OPTIONS "-mssse3")
  set(D3DCOMPILER_LIBRARY d3dcompiler_47)
endif()
target_link_libraries(cuedeck_spout_gpu PRIVATE
  d3d11 dxgi ${D3DCOMPILER_LIBRARY} opengl32 shell32 user32 gdi32
  winmm version comctl32)
