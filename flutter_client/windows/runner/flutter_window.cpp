#include "flutter_window.h"

#include <flutter/method_channel.h>
#include <flutter/standard_method_codec.h>
#include <mmdeviceapi.h>
#include <functiondiscoverykeys_devpkey.h>
#include <propvarutil.h>

#include <optional>
#include <string>

#include "flutter/generated_plugin_registrant.h"

namespace {

std::string WideToUtf8(const std::wstring& wide) {
  if (wide.empty()) {
    return std::string();
  }
  int size = ::WideCharToMultiByte(CP_UTF8, 0, wide.c_str(),
                                   static_cast<int>(wide.size()), nullptr, 0,
                                   nullptr, nullptr);
  if (size <= 0) {
    return std::string();
  }
  std::string out(static_cast<size_t>(size), '\0');
  ::WideCharToMultiByte(CP_UTF8, 0, wide.c_str(),
                        static_cast<int>(wide.size()), &out[0], size, nullptr,
                        nullptr);
  return out;
}

// 读取 Windows「默认通信设备」的友好名（和浏览器/系统默认一致）。
std::string GetDefaultEndpointName(EDataFlow flow) {
  std::string result;
  IMMDeviceEnumerator* enumerator = nullptr;
  HRESULT hr = ::CoCreateInstance(
      __uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
      __uuidof(IMMDeviceEnumerator), reinterpret_cast<void**>(&enumerator));
  if (FAILED(hr) || enumerator == nullptr) {
    return result;
  }

  IMMDevice* device = nullptr;
  // eCommunications 对齐浏览器/会议软件的默认设备选择。
  hr = enumerator->GetDefaultAudioEndpoint(flow, eCommunications, &device);
  if (FAILED(hr) || device == nullptr) {
    hr = enumerator->GetDefaultAudioEndpoint(flow, eConsole, &device);
  }
  if (SUCCEEDED(hr) && device != nullptr) {
    IPropertyStore* props = nullptr;
    if (SUCCEEDED(device->OpenPropertyStore(STGM_READ, &props)) &&
        props != nullptr) {
      PROPVARIANT var;
      ::PropVariantInit(&var);
      if (SUCCEEDED(props->GetValue(PKEY_Device_FriendlyName, &var)) &&
          var.vt == VT_LPWSTR && var.pwszVal != nullptr) {
        result = WideToUtf8(std::wstring(var.pwszVal));
      }
      ::PropVariantClear(&var);
      props->Release();
    }
    device->Release();
  }
  enumerator->Release();
  return result;
}

}  // namespace

FlutterWindow::FlutterWindow(const flutter::DartProject& project)
    : project_(project) {}

FlutterWindow::~FlutterWindow() {}

bool FlutterWindow::OnCreate() {
  if (!Win32Window::OnCreate()) {
    return false;
  }

  RECT frame = GetClientArea();

  // The size here must match the window dimensions to avoid unnecessary surface
  // creation / destruction in the startup path.
  flutter_controller_ = std::make_unique<flutter::FlutterViewController>(
      frame.right - frame.left, frame.bottom - frame.top, project_);
  // Ensure that basic setup of the controller was successful.
  if (!flutter_controller_->engine() || !flutter_controller_->view()) {
    return false;
  }
  RegisterPlugins(flutter_controller_->engine());
  SetChildContent(flutter_controller_->view()->GetNativeWindow());

  // 平台通道：把 Windows 默认录音/播放设备名交给 Dart，用于「和浏览器一样」自动选设备。
  auto audio_defaults_channel =
      std::make_shared<flutter::MethodChannel<flutter::EncodableValue>>(
          flutter_controller_->engine()->messenger(), "oopz/audio_defaults",
          &flutter::StandardMethodCodec::GetInstance());
  audio_defaults_channel->SetMethodCallHandler(
      [](const flutter::MethodCall<flutter::EncodableValue>& call,
         std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>>
             result) {
        if (call.method_name() == "getDefaults") {
          flutter::EncodableMap map;
          map[flutter::EncodableValue("input")] =
              flutter::EncodableValue(GetDefaultEndpointName(eCapture));
          map[flutter::EncodableValue("output")] =
              flutter::EncodableValue(GetDefaultEndpointName(eRender));
          result->Success(flutter::EncodableValue(map));
        } else {
          result->NotImplemented();
        }
      });

  flutter_controller_->engine()->SetNextFrameCallback([&]() {
    this->Show();
  });

  // Flutter can complete the first frame before the "show window" callback is
  // registered. The following call ensures a frame is pending to ensure the
  // window is shown. It is a no-op if the first frame hasn't completed yet.
  flutter_controller_->ForceRedraw();

  return true;
}

void FlutterWindow::OnDestroy() {
  if (flutter_controller_) {
    flutter_controller_ = nullptr;
  }

  Win32Window::OnDestroy();
}

LRESULT
FlutterWindow::MessageHandler(HWND hwnd, UINT const message,
                              WPARAM const wparam,
                              LPARAM const lparam) noexcept {
  // Give Flutter, including plugins, an opportunity to handle window messages.
  if (flutter_controller_) {
    std::optional<LRESULT> result =
        flutter_controller_->HandleTopLevelWindowProc(hwnd, message, wparam,
                                                      lparam);
    if (result) {
      return *result;
    }
  }

  switch (message) {
    case WM_FONTCHANGE:
      flutter_controller_->engine()->ReloadSystemFonts();
      break;
  }

  return Win32Window::MessageHandler(hwnd, message, wparam, lparam);
}
