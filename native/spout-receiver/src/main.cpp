/*
 * CueDeck Spout Receiver — small Windows D3D11 receiver for the Shuttle.
 *
 * It receives a Spout sender on the GPU, draws the shared texture through a
 * full-screen triangle and shows counters in the window title. It does not use
 * Resolume, OBS, Electron or a browser. Optional --sample reads four pixels
 * every half second for QA; leave it off for performance measurements.
 *
 * Build requirements: Visual Studio 2022 (C++/Win32), CMake, official Spout2
 * 2.007.018 source (see README.md). Cross-built with Zig/MinGW; runtime results
 * are recorded separately from the build.
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <d3dcompiler.h>
#include <wrl/client.h>

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "SpoutDX.h"

using Microsoft::WRL::ComPtr;

namespace {

constexpr UINT kWidth = 1280;
constexpr UINT kHeight = 720;
constexpr wchar_t kClassName[] = L"CueDeckSpoutReceiver";

struct FrameStats {
    unsigned long long frames = 0;
    unsigned long long newFrames = 0;
    double started = 0;
    double fps = 0;
    unsigned long long errors = 0;
    unsigned long long reconnects = 0;
};

ID3D11Device* g_device = nullptr;
ID3D11DeviceContext* g_context = nullptr;
IDXGISwapChain1* g_swap = nullptr;
ID3D11RenderTargetView* g_rtv = nullptr;
ID3D11VertexShader* g_vs = nullptr;
ID3D11PixelShader* g_ps = nullptr;
ID3D11SamplerState* g_sampler = nullptr;
ID3D11Texture2D* g_sender_texture = nullptr;
ID3D11ShaderResourceView* g_sender_srv = nullptr;
DXGI_FORMAT g_sender_format = DXGI_FORMAT_UNKNOWN;
UINT g_sender_width = 0;
UINT g_sender_height = 0;
UINT g_back_width = kWidth;
UINT g_back_height = kHeight;
spoutDX g_receiver;
FrameStats g_stats;
std::string g_sender_filter;
double g_last_stats_at = 0;
std::string g_adapter;
FILE* g_report = nullptr;
bool g_sample = false;
double g_seconds = 0;

std::string SamplePixels() {
    if (!g_sample || !g_sender_texture || !g_receiver.IsConnected()) return "null";
    D3D11_TEXTURE2D_DESC desc{};
    g_sender_texture->GetDesc(&desc);
    if (desc.Format != DXGI_FORMAT_B8G8R8A8_UNORM && desc.Format != DXGI_FORMAT_R8G8B8A8_UNORM) return "null";
    D3D11_TEXTURE2D_DESC sample{};
    sample.Width = 4; sample.Height = 1; sample.MipLevels = 1; sample.ArraySize = 1;
    sample.Format = desc.Format; sample.SampleDesc.Count = 1;
    sample.Usage = D3D11_USAGE_STAGING; sample.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    ComPtr<ID3D11Texture2D> staging;
    if (FAILED(g_device->CreateTexture2D(&sample, nullptr, &staging))) return "null";
    for (UINT i = 0; i < 4; ++i) {
        const UINT x = desc.Width * (i % 2 == 0 ? 1 : 3) / 4;
        const UINT y = desc.Height * (i < 2 ? 1 : 3) / 4;
        const D3D11_BOX box{x, y, 0, x + 1, y + 1, 1};
        g_context->CopySubresourceRegion(staging.Get(), 0, i, 0, 0, g_sender_texture, 0, &box);
    }
    D3D11_MAPPED_SUBRESOURCE mapped{};
    if (FAILED(g_context->Map(staging.Get(), 0, D3D11_MAP_READ, 0, &mapped))) return "null";
    std::string result = "[";
    const auto* pixels = static_cast<const unsigned char*>(mapped.pData);
    for (int i = 0; i < 4; ++i) {
        const auto* p = pixels + i * 4;
        const bool bgra = desc.Format == DXGI_FORMAT_B8G8R8A8_UNORM;
        char text[64];
        std::snprintf(text, sizeof(text), "%s[%u,%u,%u,%u]", i ? "," : "", p[bgra ? 2 : 0], p[1], p[bgra ? 0 : 2], p[3]);
        result += text;
    }
    g_context->Unmap(staging.Get(), 0);
    return result + "]";
}

double NowSeconds() {
    LARGE_INTEGER f, t;
    QueryPerformanceFrequency(&f);
    QueryPerformanceCounter(&t);
    return static_cast<double>(t.QuadPart) / static_cast<double>(f.QuadPart);
}

void ReleaseBackbuffer() {
    if (g_rtv) { g_rtv->Release(); g_rtv = nullptr; }
}

bool CreateBackbuffer() {
    ReleaseBackbuffer();
    ComPtr<ID3D11Texture2D> back;
    if (FAILED(g_swap->GetBuffer(0, IID_PPV_ARGS(&back)))) {
        g_stats.errors++;
        return false;
    }
    D3D11_TEXTURE2D_DESC desc{};
    back->GetDesc(&desc);
    g_back_width = desc.Width;
    g_back_height = desc.Height;
    if (FAILED(g_device->CreateRenderTargetView(back.Get(), nullptr, &g_rtv))) {
        g_stats.errors++;
        return false;
    }
    return true;
}

bool ResizeSwapchain(UINT width, UINT height) {
    if (!g_swap || width == 0 || height == 0) return true;
    ReleaseBackbuffer();
    if (FAILED(g_swap->ResizeBuffers(0, width, height, DXGI_FORMAT_UNKNOWN, 0))) {
        g_stats.errors++;
        return false;
    }
    return CreateBackbuffer();
}

bool CreateSwapchain(HWND hwnd) {
    ComPtr<IDXGIDevice> dxgi_device;
    if (FAILED(g_device->QueryInterface(IID_PPV_ARGS(&dxgi_device)))) return false;
    ComPtr<IDXGIAdapter> adapter;
    dxgi_device->GetAdapter(&adapter);
    DXGI_ADAPTER_DESC desc{};
    if (adapter && SUCCEEDED(adapter->GetDesc(&desc))) {
        char buf[512]{};
        WideCharToMultiByte(CP_UTF8, 0, desc.Description, -1, buf, sizeof(buf), nullptr, nullptr);
        g_adapter = buf;
    }
    if (!adapter) return false;
    ComPtr<IDXGIFactory2> factory;
    if (FAILED(adapter->GetParent(IID_PPV_ARGS(&factory)))) return false;
    DXGI_SWAP_CHAIN_DESC1 sd{};
    sd.Width = kWidth;
    sd.Height = kHeight;
    sd.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
    sd.SampleDesc.Count = 1;
    sd.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
    sd.BufferCount = 2;
    sd.SwapEffect = DXGI_SWAP_EFFECT_DISCARD;
    if (FAILED(factory->CreateSwapChainForHwnd(g_device, hwnd, &sd, nullptr, nullptr, &g_swap))) return false;
    return CreateBackbuffer();
}

bool RefreshSenderTexture() {
    ID3D11Texture2D* tex = g_receiver.GetSenderTexture();
    if (!tex) return false;
    DXGI_FORMAT format = g_receiver.GetSenderFormat();
    UINT width = g_receiver.GetSenderWidth();
    UINT height = g_receiver.GetSenderHeight();
    if (tex == g_sender_texture && format == g_sender_format && width == g_sender_width && height == g_sender_height) return true;
    if (g_sender_srv) { g_sender_srv->Release(); g_sender_srv = nullptr; }
    g_sender_texture = tex;
    g_sender_format = format;
    g_sender_width = width;
    g_sender_height = height;
    if (FAILED(g_device->CreateShaderResourceView(tex, nullptr, &g_sender_srv))) {
        g_stats.errors++;
        return false;
    }
    return true;
}

bool CompileShaders() {
    static const char kHLSL[] = R"(
        struct VSOut { float4 pos : SV_Position; float2 uv : TEXCOORD0; };
        VSOut VSMain(uint id : SV_VertexID) {
            float2 p = float2((id == 1) ? 3.0 : -1.0, (id == 2) ? 3.0 : -1.0);
            VSOut o;
            o.pos = float4(p, 0.0, 1.0);
            o.uv = float2((p.x + 1.0) * 0.5, 1.0 - (p.y + 1.0) * 0.5);
            return o;
        }
        Texture2D frame : register(t0);
        SamplerState linearSampler : register(s0);
        float4 PSMain(VSOut i) : SV_Target { return frame.Sample(linearSampler, i.uv); }
    )";
    ComPtr<ID3DBlob> vs_blob, ps_blob, errors;
    UINT flags = D3DCOMPILE_ENABLE_STRICTNESS;
    if (FAILED(D3DCompile(kHLSL, strlen(kHLSL), nullptr, nullptr, nullptr, "VSMain", "vs_5_0", flags, 0, &vs_blob, &errors))) return false;
    if (FAILED(D3DCompile(kHLSL, strlen(kHLSL), nullptr, nullptr, nullptr, "PSMain", "ps_5_0", flags, 0, &ps_blob, &errors))) return false;
    if (FAILED(g_device->CreateVertexShader(vs_blob->GetBufferPointer(), vs_blob->GetBufferSize(), nullptr, &g_vs))) return false;
    if (FAILED(g_device->CreatePixelShader(ps_blob->GetBufferPointer(), ps_blob->GetBufferSize(), nullptr, &g_ps))) return false;
    D3D11_SAMPLER_DESC sd{};
    sd.Filter = D3D11_FILTER_MIN_MAG_MIP_LINEAR;
    sd.AddressU = D3D11_TEXTURE_ADDRESS_CLAMP;
    sd.AddressV = D3D11_TEXTURE_ADDRESS_CLAMP;
    sd.AddressW = D3D11_TEXTURE_ADDRESS_CLAMP;
    if (FAILED(g_device->CreateSamplerState(&sd, &g_sampler))) return false;
    return true;
}

void UpdateTitle(HWND hwnd) {
    std::string line = "CueDeck Spout Receiver";
    line += " | sender: ";
    line += g_receiver.IsConnected() ? g_receiver.GetSenderName() : "(waiting)";
    char buffer[512]{};
    std::snprintf(buffer, sizeof(buffer), " | %ux%u %s | %.1f draw fps | draws %llu | err %llu | %s",
        g_sender_width, g_sender_height,
        g_sender_format == DXGI_FORMAT_B8G8R8A8_UNORM ? "BGRA8" :
        g_sender_format == DXGI_FORMAT_R8G8B8A8_UNORM ? "RGBA8" : "fmt?",
        g_stats.fps, g_stats.frames, g_stats.errors, g_adapter.c_str());
    line += buffer;
    wchar_t wide[1024]{};
    MultiByteToWideChar(CP_UTF8, 0, line.c_str(), -1, wide, 1024);
    SetWindowTextW(hwnd, wide);
}

void Render(HWND hwnd) {
    if (!g_rtv) {
        if (g_swap) g_swap->Present(1, 0);
        return;
    }
    g_context->OMSetRenderTargets(1, &g_rtv, nullptr);
    const float clear[4] = {0.02f, 0.02f, 0.02f, 1.0f};
    g_context->ClearRenderTargetView(g_rtv, clear);
    if (g_receiver.ReceiveTexture() && g_receiver.IsConnected()) {
        if (g_receiver.IsFrameCountEnabled() && g_receiver.IsFrameNew()) g_stats.newFrames++;
        if (g_receiver.IsUpdated()) g_stats.reconnects++;
        if (RefreshSenderTexture() && g_sender_srv && g_vs && g_ps && g_sampler) {
            D3D11_VIEWPORT vp{};
            vp.Width = static_cast<float>(g_back_width);
            vp.Height = static_cast<float>(g_back_height);
            vp.MaxDepth = 1.0f;
            g_context->RSSetViewports(1, &vp);
            ID3D11ShaderResourceView* srv = g_sender_srv;
            ID3D11SamplerState* sampler = g_sampler;
            g_context->PSSetShaderResources(0, 1, &srv);
            g_context->PSSetSamplers(0, 1, &sampler);
            g_context->VSSetShader(g_vs, nullptr, 0);
            g_context->PSSetShader(g_ps, nullptr, 0);
            g_context->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
            g_context->Draw(3, 0);
            g_stats.frames++;
        }
    }
    if (g_swap->Present(1, 0) == DXGI_ERROR_DEVICE_REMOVED) {
        g_stats.errors++;
        g_stats.reconnects++;
    }
    const double now = NowSeconds();
    if (now - g_last_stats_at >= 0.5) {
        g_stats.fps = g_stats.frames / std::max(0.001, now - g_stats.started);
        g_last_stats_at = now;
        UpdateTitle(hwnd);
        if (g_report) {
            const auto samples = SamplePixels();
            std::fprintf(g_report, "{\"elapsed\":%.3f,\"connected\":%s,\"width\":%u,\"height\":%u,\"format\":%u,\"draws\":%llu,\"newFrames\":%llu,\"frameCounting\":%s,\"senderFrame\":%ld,\"errors\":%llu,\"reconnects\":%llu,\"rgba\":%s}\n",
                now - g_stats.started, g_receiver.IsConnected() ? "true" : "false",
                g_sender_width, g_sender_height, static_cast<unsigned>(g_sender_format),
                g_stats.frames, g_stats.newFrames, g_receiver.IsFrameCountEnabled() ? "true" : "false",
                g_receiver.GetSenderFrame(), g_stats.errors, g_stats.reconnects, samples.c_str());
            std::fflush(g_report);
        }
    }
}

LRESULT CALLBACK WndProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {
        case WM_SIZE:
            if (g_swap && wp != SIZE_MINIMIZED) ResizeSwapchain(LOWORD(lp), HIWORD(lp));
            return 0;
        case WM_DESTROY: PostQuitMessage(0); return 0;
        case WM_KEYDOWN:
            if (wp == VK_ESCAPE) { PostQuitMessage(0); return 0; }
            break;
        default: break;
    }
    return DefWindowProcW(hwnd, msg, wp, lp);
}

void ReleaseAll() {
    if (g_sender_srv) { g_sender_srv->Release(); g_sender_srv = nullptr; }
    g_sender_texture = nullptr;
    if (g_sampler) { g_sampler->Release(); g_sampler = nullptr; }
    if (g_ps) { g_ps->Release(); g_ps = nullptr; }
    if (g_vs) { g_vs->Release(); g_vs = nullptr; }
    ReleaseBackbuffer();
    if (g_swap) { g_swap->Release(); g_swap = nullptr; }
    g_receiver.ReleaseReceiver();
    g_receiver.CloseDirectX11();
    if (g_context) { g_context->Release(); g_context = nullptr; }
    if (g_device) { g_device->Release(); g_device = nullptr; }
}

} // namespace

int WINAPI wWinMain(HINSTANCE hInstance, HINSTANCE, PWSTR, int) {
    // Optional: --sender "Spout name". Spout also allows an in-app selector,
    // but this small receiver keeps the test path non-interactive by default.
    int argc = 0;
    LPWSTR* argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    if (argv) {
        for (int i = 1; i < argc; i++) {
            if (std::wstring(argv[i]) == L"--sample") g_sample = true;
            else if (std::wstring(argv[i]) == L"--seconds" && i + 1 < argc) g_seconds = _wtof(argv[++i]);
            else if (std::wstring(argv[i]) == L"--report" && i + 1 < argc) {
                g_report = _wfopen(argv[++i], L"wb");
                if (!g_report) { LocalFree(argv); return 4; }
            }
            else if (std::wstring(argv[i]) == L"--sender" && i + 1 < argc) {
                char name[256]{};
                WideCharToMultiByte(CP_UTF8, 0, argv[++i], -1, name, sizeof(name), nullptr, nullptr);
                g_sender_filter = name;
            }
        }
        LocalFree(argv);
    }
    if (!g_receiver.OpenDirectX11()) return 2;
    g_device = g_receiver.GetDX11Device();
    g_context = g_receiver.GetDX11Context();
    if (!g_device || !g_context) { g_receiver.CloseDirectX11(); return 2; }
    g_device->AddRef();
    g_context->AddRef();
    if (!g_sender_filter.empty()) g_receiver.SetReceiverName(g_sender_filter.c_str());

    WNDCLASSEXW wc{};
    wc.cbSize = sizeof(wc);
    wc.lpfnWndProc = WndProc;
    wc.hInstance = hInstance;
    wc.hCursor = LoadCursor(nullptr, IDC_ARROW);
    wc.lpszClassName = kClassName;
    if (!RegisterClassExW(&wc)) { ReleaseAll(); return 2; }
    RECT rc{0, 0, static_cast<LONG>(kWidth), static_cast<LONG>(kHeight)};
    AdjustWindowRect(&rc, WS_OVERLAPPEDWINDOW, FALSE);
    HWND hwnd = CreateWindowExW(0, kClassName, L"CueDeck Spout Receiver",
        WS_OVERLAPPEDWINDOW, CW_USEDEFAULT, CW_USEDEFAULT,
        rc.right - rc.left, rc.bottom - rc.top, nullptr, nullptr, hInstance, nullptr);
    if (!hwnd) { ReleaseAll(); return 2; }
    ShowWindow(hwnd, SW_SHOW);
    if (!CreateSwapchain(hwnd) || !CompileShaders()) {
        std::fprintf(stderr, "receiver: D3D init/shader failed\n");
        ReleaseAll();
        return 3;
    }
    g_stats.started = NowSeconds();
    MSG msg{};
    while (msg.message != WM_QUIT) {
        while (PeekMessageW(&msg, nullptr, 0, 0, PM_REMOVE)) {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        if (msg.message != WM_QUIT) Render(hwnd);
        if (g_seconds > 0 && NowSeconds() - g_stats.started >= g_seconds) break;
    }
    ReleaseAll();
    DestroyWindow(hwnd);
    UnregisterClassW(kClassName, hInstance);
    if (g_report) std::fclose(g_report);
    return 0;
}
