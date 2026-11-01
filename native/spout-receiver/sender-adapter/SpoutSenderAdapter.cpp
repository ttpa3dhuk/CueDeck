#include "SpoutSenderAdapter.h"
#include "SpoutDX.h"
#include <string>

bool SpoutSenderAdapter::open(ID3D11Device* device, const char* senderName) {
    close();
    if (!device || !senderName) return false;
    auto* sender = new spoutDX();
    if (!sender->OpenDirectX11(device)) { delete sender; return false; }
    sender->SetSenderFormat(DXGI_FORMAT_B8G8R8A8_UNORM);
    if (!sender->SetSenderName(senderName)) { sender->CloseDirectX11(); delete sender; return false; }
    impl_ = sender;
    open_ = true;
    return true;
}

bool SpoutSenderAdapter::send(ID3D11Texture2D* texture) {
    if (!open_ || !texture || !impl_) return false;
    return static_cast<spoutDX*>(impl_)->SendTexture(texture);
}

void SpoutSenderAdapter::close() {
    if (impl_) {
        auto* sender = static_cast<spoutDX*>(impl_);
        sender->ReleaseSender();
        sender->CloseDirectX11();
        delete sender;
        impl_ = nullptr;
    }
    open_ = false;
}
