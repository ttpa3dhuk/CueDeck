// In-process Electron OSR DXGI-handle -> Spout2 GPU sender.
// The caller retains OffscreenSharedTexture until poll returns completion.
#include <windows.h>
#include <d3d11_1.h>
#include <dxgi1_2.h>
#include <wrl/client.h>
#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <cstring>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include "SpoutDX.h"

using Microsoft::WRL::ComPtr;
namespace {
constexpr uint32_t kBgra = 1;
constexpr uint32_t kRgba = 2;
constexpr size_t kResultBytes = 16;

void set_error(char* out, uint64_t length, const char* message) {
  if (!out || !length) return;
  const size_t n = static_cast<size_t>(length - 1);
  std::strncpy(out, message, n);
  out[n] = 0;
}

void write_result(uint8_t* out, uint64_t frame, uint32_t status, uint32_t detail) {
  for (unsigned i = 0; i < 8; ++i) out[i] = static_cast<uint8_t>(frame >> (8 * i));
  for (unsigned i = 0; i < 4; ++i) {
    out[8 + i] = static_cast<uint8_t>(status >> (8 * i));
    out[12 + i] = static_cast<uint8_t>(detail >> (8 * i));
  }
}

struct Job {
  HANDLE handle = nullptr; // borrowed; Electron owns it until completion is polled
  uint32_t width = 0, height = 0, stride = 0, format = 0;
  uint64_t frame = 0;
};

struct Result { uint64_t frame = 0; uint32_t status = 0, detail = 0; };

struct Publisher {
  explicit Publisher(std::string sender_name) : name(std::move(sender_name)) {}
  std::string name;
  std::mutex mutex;
  std::condition_variable cv;
  Job job;
  Result result;
  bool queued = false, busy = false, complete = false, stopping = false, closed = false;
  ComPtr<ID3D11Device1> device; // used only on worker
  ComPtr<ID3D11DeviceContext> context;
  std::unique_ptr<spoutDX> sender;

  HRESULT open_on_matching_adapter(HANDLE handle, ComPtr<ID3D11Texture2D>& texture) {
    // Existing device is the normal case. A changed Chromium GPU adapter is
    // detected by failing OpenSharedResource1 and re-enumerating adapters.
    if (device) {
      HRESULT hr = device->OpenSharedResource1(handle, IID_PPV_ARGS(&texture));
      if (SUCCEEDED(hr)) return hr;
      if (sender) { sender->ReleaseSender(); sender->CloseDirectX11(); sender.reset(); }
      context.Reset(); device.Reset();
    }
    ComPtr<IDXGIFactory1> factory;
    HRESULT last = CreateDXGIFactory1(IID_PPV_ARGS(&factory));
    if (FAILED(last)) return last;
    for (UINT index = 0;; ++index) {
      ComPtr<IDXGIAdapter1> adapter;
      HRESULT hr = factory->EnumAdapters1(index, &adapter);
      if (hr == DXGI_ERROR_NOT_FOUND) break;
      if (FAILED(hr)) { last = hr; break; }
      DXGI_ADAPTER_DESC1 adapter_desc{};
      adapter->GetDesc1(&adapter_desc);
      if (adapter_desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE) continue;
      ComPtr<ID3D11Device> base;
      ComPtr<ID3D11DeviceContext> candidate_context;
      hr = D3D11CreateDevice(adapter.Get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr,
          D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0, D3D11_SDK_VERSION,
          &base, nullptr, &candidate_context);
      if (FAILED(hr)) { last = hr; continue; }
      ComPtr<ID3D11Device1> candidate;
      hr = base.As(&candidate);
      if (FAILED(hr)) { last = hr; continue; }
      hr = candidate->OpenSharedResource1(handle, IID_PPV_ARGS(&texture));
      if (SUCCEEDED(hr)) {
        device = candidate;
        context = candidate_context;
        return S_OK;
      }
      last = hr;
    }
    return last;
  }

  Result process(const Job& work) {
    Result out{work.frame, 1, 0};
    ComPtr<ID3D11Texture2D> texture;
    HRESULT hr = open_on_matching_adapter(work.handle, texture);
    if (FAILED(hr)) { out.detail = static_cast<uint32_t>(hr); return out; }
    D3D11_TEXTURE2D_DESC desc{};
    texture->GetDesc(&desc);
    const DXGI_FORMAT expected = work.format == kBgra ? DXGI_FORMAT_B8G8R8A8_UNORM
        : DXGI_FORMAT_R8G8B8A8_UNORM;
    if (desc.Width != work.width || desc.Height != work.height ||
        desc.Format != expected || desc.ArraySize != 1 || desc.SampleDesc.Count != 1 ||
        work.stride != work.width * 4u) {
      out.detail = 0xC0010001u; return out;
    }
    // Electron 33 ARGB/ABGR OSR has no keyed mutex. A keyed source has an
    // unspecified producer key, so fail instead of reading an unsynchronized GPU
    // texture. Future Electron formats need an explicit synchronization contract.
    ComPtr<IDXGIKeyedMutex> source_mutex;
    if (SUCCEEDED(texture.As(&source_mutex))) {
      out.detail = 0xC0010005u; return out;
    }
    if (!sender) {
      sender = std::make_unique<spoutDX>();
      sender->OpenDirectX11(device.Get());
      // The pinned SpoutDX implementation returns true unconditionally here.
      if (sender->GetDX11Device() != device.Get() || !sender->GetDX11Context()) {
        sender->CloseDirectX11(); sender.reset();
        out.detail = 0xC0010006u; return out;
      }
      sender->SetSenderFormat(expected);
      if (!sender->SetSenderName(name.c_str())) {
        sender->CloseDirectX11(); sender.reset();
        out.detail = 0xC0010002u; return out;
      }
    }
    D3D11_QUERY_DESC query_desc{D3D11_QUERY_EVENT, 0};
    ComPtr<ID3D11Query> query;
    hr = device->CreateQuery(&query_desc, &query);
    if (FAILED(hr)) {
      out.detail = static_cast<uint32_t>(hr); return out;
    }
    // SendTexture performs a GPU CopyResource into Spout's own shared texture.
    // Its named sender mutex can wait; all work is on the native worker thread.
    // The vendor API may return true even if that mutex timed out and no frame
    // was copied, so compare its own frame counter when counting is enabled.
    const long before_frame = sender->GetFrame();
    const bool sent = sender->SendTexture(texture.Get());
    if (!sent) {
      out.detail = 0xC0010003u; return out;
    }
    const bool skipped = sender->IsFrameCountEnabled() && sender->GetFrame() == before_frame;
    context->End(query.Get());
    context->Flush();
    // Do not return ownership of Electron's handle until GPU work is complete.
    for (;;) {
      BOOL finished = FALSE;
      // Allow the driver to submit pending query work. DONOTFLUSH can starve
      // completion on NVIDIA even after Flush(), holding Electron's frame.
      hr = context->GetData(query.Get(), &finished, sizeof(finished), 0);
      if (hr == S_OK && finished) break;
      if (FAILED(hr)) {
        // Device failure terminates GPU work; no successful publication claim.
        out.detail = static_cast<uint32_t>(hr);
        return out;
      }
      Sleep(1);
    }
    if (skipped) { out.detail = 0xC0010004u; return out; }
    out.status = 0;
    return out;
  }

  void run() {
    for (;;) {
      Job work;
      {
        std::unique_lock<std::mutex> lock(mutex);
        cv.wait(lock, [&] { return queued || stopping; });
        if (stopping && !queued) break;
        work = job; queued = false;
      }
      Result finished = process(work);
      {
        std::lock_guard<std::mutex> lock(mutex);
        result = finished; complete = true;
      }
    }
    if (sender) { sender->ReleaseSender(); sender->CloseDirectX11(); sender.reset(); }
    {
      std::lock_guard<std::mutex> lock(mutex);
      closed = true;
    }
  }
};
} // namespace

extern "C" {
__declspec(dllexport) void* cuedeck_gpu_publisher_create(
    const char* name, int is_private, int flip_y, char* error, uint64_t error_length) {
  if (!name || !*name || is_private || flip_y) {
    set_error(error, error_length, "Spout needs a public sender name and top-left frame; private/flipY unsupported");
    return nullptr;
  }
  try {
    auto pub = std::make_shared<Publisher>(name);
    auto holder = std::make_unique<std::shared_ptr<Publisher>>(pub);
    // The worker owns the Publisher until any in-flight GPU operation finishes.
    // The C ABI holder can be destroyed immediately without waiting on D3D.
    std::thread([pub] { pub->run(); }).detach();
    return holder.release();
  } catch (...) {
    set_error(error, error_length, "cannot start Spout sender worker");
    return nullptr;
  }
}

__declspec(dllexport) void cuedeck_gpu_publisher_request_close(void* publisher) {
  auto* holder = static_cast<std::shared_ptr<Publisher>*>(publisher);
  if (!holder) return;
  auto pub = *holder;
  {
    std::lock_guard<std::mutex> lock(pub->mutex);
    pub->stopping = true;
  }
  pub->cv.notify_one();
}

__declspec(dllexport) int cuedeck_gpu_publisher_poll_closed(void* publisher) {
  auto* holder = static_cast<std::shared_ptr<Publisher>*>(publisher);
  if (!holder) return 1;
  auto pub = *holder;
  std::lock_guard<std::mutex> lock(pub->mutex);
  return pub->closed ? 1 : 0;
}

__declspec(dllexport) void cuedeck_gpu_publisher_destroy(void* publisher) {
  auto* holder = static_cast<std::shared_ptr<Publisher>*>(publisher);
  if (!holder) return;
  cuedeck_gpu_publisher_request_close(publisher);
  delete holder;
}

__declspec(dllexport) int cuedeck_gpu_publisher_submit(void* publisher,
    const uint8_t* handle, uint64_t length, uint32_t width, uint32_t height,
    uint32_t stride, uint32_t pixel_format, uint64_t frame_id,
    char* error, uint64_t error_length) {
  auto* holder = static_cast<std::shared_ptr<Publisher>*>(publisher);
  if (!holder || !handle || length != sizeof(HANDLE) || !width || !height ||
      width > UINT32_MAX / 4u || stride != width * 4u || !frame_id ||
      (pixel_format != kBgra && pixel_format != kRgba)) {
    set_error(error, error_length, "invalid Spout GPU submit arguments");
    return -1;
  }
  HANDLE shared = nullptr;
  auto pub = *holder;
  std::memcpy(&shared, handle, sizeof(shared));
  if (!shared) { set_error(error, error_length, "null DXGI shared handle"); return -1; }
  {
    std::lock_guard<std::mutex> lock(pub->mutex);
    if (pub->stopping || pub->busy) {
      set_error(error, error_length, "Spout GPU sender is stopped or has one frame in flight");
      return -2;
    }
    pub->job = Job{shared, width, height, stride, pixel_format, frame_id};
    pub->busy = true; pub->queued = true;
  }
  pub->cv.notify_one();
  return 0;
}

__declspec(dllexport) int cuedeck_gpu_publisher_poll(void* publisher, uint8_t* out, uint64_t length) {
  auto* holder = static_cast<std::shared_ptr<Publisher>*>(publisher);
  if (!holder || !out || length < kResultBytes) return -1;
  auto pub = *holder;
  std::lock_guard<std::mutex> lock(pub->mutex);
  if (!pub->complete) return 0;
  write_result(out, pub->result.frame, pub->result.status, pub->result.detail);
  pub->complete = false; pub->busy = false;
  return 1;
}

__declspec(dllexport) int cuedeck_gpu_publisher_pending(void* publisher) {
  auto* holder = static_cast<std::shared_ptr<Publisher>*>(publisher);
  if (!holder) return 0;
  auto pub = *holder;
  std::lock_guard<std::mutex> lock(pub->mutex);
  return pub->busy ? 1 : 0;
}
}
