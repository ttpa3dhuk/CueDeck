#pragma once
#include <d3d11.h>

// Minimal future Windows GPU sender adapter. It accepts an ID3D11Texture2D;
// a Windows native helper would first open Electron's DXGI shared handle with
// ID3D11Device::OpenSharedResource1 and then call SendTexture. This adapter is
// source-only here: it has not been compiled or run on the Shuttle.
class SpoutSenderAdapter {
public:
    bool open(ID3D11Device* device, const char* senderName);
    bool send(ID3D11Texture2D* texture);
    void close();
private:
    void* impl_ = nullptr;
    bool open_ = false;
};
