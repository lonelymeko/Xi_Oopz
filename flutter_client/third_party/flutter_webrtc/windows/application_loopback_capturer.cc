#ifdef _WIN32

#include "application_loopback_capturer.h"

#include <avrt.h>
#include <chrono>
#include <cstring>
#include <iostream>
#include <mmdeviceapi.h>
#include <roapi.h>
#include <string>
#include <timeapi.h>

// ---------------------------------------------------------------------------
// ApplicationLoopbackAudio API types
// These structs were introduced in Windows SDK 10.0.20348.0.  We define them
// here so the file compiles against older SDKs as well; the feature is
// detected at runtime via a probe activation attempt.
// ---------------------------------------------------------------------------
#ifndef AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK

typedef enum AUDIOCLIENT_ACTIVATION_TYPE {
  AUDIOCLIENT_ACTIVATION_TYPE_DEFAULT = 0,
  AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK = 1,
} AUDIOCLIENT_ACTIVATION_TYPE;

typedef enum PROCESS_LOOPBACK_MODE {
  PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE = 0,
  PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE = 1,
} PROCESS_LOOPBACK_MODE;

typedef struct AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
  DWORD TargetProcessId;
  PROCESS_LOOPBACK_MODE ProcessLoopbackMode;
} AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS;

typedef struct AUDIOCLIENT_ACTIVATION_PARAMS {
  AUDIOCLIENT_ACTIVATION_TYPE ActivationType;
  union {
    AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS ProcessLoopbackParams;
  };
} AUDIOCLIENT_ACTIVATION_PARAMS;

// Special device string that routes to the system render mix.
#define VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK L"VAD\\Process_Loopback"

#endif  // AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK

namespace flutter_webrtc_plugin {

// ---------------------------------------------------------------------------
// COM completion handler for ActivateAudioInterfaceAsync
// ---------------------------------------------------------------------------

// Helper for managing the COM async activation callback used to probe for
// ApplicationLoopbackAudio support and to activate the IAudioClient when starting capture.
struct HandleDeleter {
  void operator()(HANDLE h) const { CloseHandle(h); }
};
using UniqueHandle = std::unique_ptr<std::remove_pointer_t<HANDLE>, HandleDeleter>;

class ActivationCompletionHandler
    : public IActivateAudioInterfaceCompletionHandler {
 public:
  UniqueHandle event_{CreateEvent(nullptr, FALSE, FALSE, nullptr)};
  IAudioClient* client_ = nullptr;
  HRESULT activation_result_ = E_FAIL;

  // IActivateAudioInterfaceCompletionHandler
  HRESULT STDMETHODCALLTYPE ActivateCompleted(
      IActivateAudioInterfaceAsyncOperation* op) override {
    IUnknown* unk = nullptr;
    op->GetActivateResult(&activation_result_, &unk);
    if (SUCCEEDED(activation_result_) && unk) {
      unk->QueryInterface(IID_PPV_ARGS(&client_));
      unk->Release();
    }
    if (event_) SetEvent(event_.get());
    return S_OK;
  }

  // IUnknown
  ULONG STDMETHODCALLTYPE AddRef() override {
    return InterlockedIncrement(&ref_);
  }
  ULONG STDMETHODCALLTYPE Release() override {
    ULONG r = InterlockedDecrement(&ref_);
    if (r == 0) delete this;
    return r;
  }
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid,
                                           void** ppv) override {
    // IAgileObject = {94ea2b94-e9cc-49e0-c0ff-ee64ca8f5b90}
    // ActivateAudioInterfaceAsync QI's for IAgileObject and returns
    // RO_E_WRONG_THREAD if the handler doesn't claim to be agile.
    static const GUID kIAgileObject =
        {0x94ea2b94,0xe9cc,0x49e0,{0xc0,0xff,0xee,0x64,0xca,0x8f,0x5b,0x90}};
    if (riid == IID_IUnknown ||
        riid == __uuidof(IActivateAudioInterfaceCompletionHandler) ||
        riid == kIAgileObject) {
      *ppv = static_cast<IActivateAudioInterfaceCompletionHandler*>(this);
      AddRef();
      return S_OK;
    }
    *ppv = nullptr;
    return E_NOINTERFACE;
  }

 private:
  volatile ULONG ref_ = 1;
};

// ---------------------------------------------------------------------------
// ApplicationLoopbackCapturer
// ---------------------------------------------------------------------------

ApplicationLoopbackCapturer::ApplicationLoopbackCapturer() = default;

ApplicationLoopbackCapturer::~ApplicationLoopbackCapturer() {
  Stop();
}

bool ApplicationLoopbackCapturer::Start(
    scoped_refptr<RTCAudioSource> source) {
  if (running_) return true;

    source_ = source;

  audio_client_ = TryInitApplicationLoopback();
  if (!audio_client_) {
    std::cerr << "[LoopbackCapturer] ApplicationLoopback init failed.\n";
    return false;
  }

  buffer_ready_event_ = CreateEvent(nullptr, FALSE, FALSE, nullptr);
  if (buffer_ready_event_ == nullptr) {
    audio_client_->Release();
    audio_client_ = nullptr;
    return false;
  }

  HRESULT hr = audio_client_->SetEventHandle(buffer_ready_event_);
  if (FAILED(hr)) {
    std::cerr << "[LoopbackCapturer] SetEventHandle failed: 0x" << std::hex
              << hr << "\n";
    audio_client_->Release();
    audio_client_ = nullptr;
    CloseHandle(buffer_ready_event_);
    buffer_ready_event_ = nullptr;
    return false;
  }

  hr = audio_client_->GetService(IID_PPV_ARGS(&capture_client_));
  if (FAILED(hr)) {
    std::cerr << "[LoopbackCapturer] GetService(IAudioCaptureClient) failed: 0x"
              << std::hex << hr << "\n";
    audio_client_->Release();
    audio_client_ = nullptr;
    CloseHandle(buffer_ready_event_);
    buffer_ready_event_ = nullptr;
    return false;
  }

  hr = audio_client_->Start();
  if (FAILED(hr)) {
    std::cerr << "[LoopbackCapturer] IAudioClient::Start failed: 0x"
              << std::hex << hr << "\n";
    capture_client_->Release();
    capture_client_ = nullptr;
    audio_client_->Release();
    audio_client_ = nullptr;
    CloseHandle(buffer_ready_event_);
    buffer_ready_event_ = nullptr;
    return false;
  }

  running_ = true;

  // Cache audio format for FeederThread (mix_format_ lives on this thread).
  cached_sample_rate_  = static_cast<int>(mix_format_->nSamplesPerSec);
  cached_out_channels_ = 1;
  // Initialise ring buffer: 500 ms of mono int16 samples.
  {
    const size_t frames_per_20ms =
        static_cast<size_t>(cached_sample_rate_) / 50;
    ring_capacity_frames_ = 25 * frames_per_20ms;   // 500 ms headroom
    ring_buf_.assign(ring_capacity_frames_ * cached_out_channels_, int16_t{0});
    ring_write_frame_ = 0;
    ring_read_frame_  = 0;
    ring_frames_avail_ = 0;
  }

  // 麦克风环 + 采集（混进 loopback；失败则退化为只发系统音频）。
  mic_capacity_frames_ = ring_capacity_frames_;
  mic_ring_.assign(mic_capacity_frames_, int16_t{0});
  mic_write_frame_ = 0;
  mic_read_frame_  = 0;
  mic_frames_avail_ = 0;
  mic_ok_ = StartMic();
  if (mic_ok_) {
    mic_running_ = true;
    mic_thread_ = std::thread(&ApplicationLoopbackCapturer::MicThread, this);
    std::cout << "[LoopbackCapturer] microphone mixed into screen audio.\n";
  } else {
    std::cerr << "[LoopbackCapturer] mic capture disabled (system audio only).\n";
  }

  capture_thread_ = std::thread(&ApplicationLoopbackCapturer::CaptureThread, this);
  feeder_thread_  = std::thread(&ApplicationLoopbackCapturer::FeederThread,  this);
  // std::cout << "[LoopbackCapturer] Capture started ("
  //           << mix_format_->nSamplesPerSec << " Hz, "
  //           << cached_out_channels_ << " ch out"
  //           << " [" << mix_format_->nChannels << " ch in], "
  //           << mix_format_->wBitsPerSample << "-bit).\n";
  return true;
}

void ApplicationLoopbackCapturer::Stop() {
  if (!running_) return;
  running_ = false;

  // Wake the capture thread so it can exit the WaitForSingleObject loop.
  if (buffer_ready_event_ != nullptr) {
    SetEvent(buffer_ready_event_);
  }
  if (capture_thread_.joinable()) {
    capture_thread_.join();
  }
  if (feeder_thread_.joinable()) {
    feeder_thread_.join();
  }

  StopMic();

  if (audio_client_) {
    audio_client_->Stop();
    audio_client_->Release();
    audio_client_ = nullptr;
  }
  if (capture_client_) {
    capture_client_->Release();
    capture_client_ = nullptr;
  }
  if (mix_format_) {
    CoTaskMemFree(mix_format_);
    mix_format_ = nullptr;
  }
  if (buffer_ready_event_ != nullptr) {
    CloseHandle(buffer_ready_event_);
    buffer_ready_event_ = nullptr;
  }
  source_ = nullptr;
  // std::cout << "[LoopbackCapturer] Capture stopped.\n";
}

// ---------------------------------------------------------------------------
// TryInitApplicationLoopback
// ---------------------------------------------------------------------------
IAudioClient* ApplicationLoopbackCapturer::TryInitApplicationLoopback() {
  struct Result {
    IAudioClient* client = nullptr;
    WAVEFORMATEX* fmt    = nullptr;
  };
  Result result;
  HANDLE done_event = CreateEvent(nullptr, FALSE, FALSE, nullptr);

  std::thread worker([&result, done_event, this]() {
    // RoInitialize(MTA) — the real requirement is that the completion handler
    // supports IAgileObject (see QueryInterface above).  Without that,
    // ActivateAudioInterfaceAsync returns RO_E_WRONG_THREAD regardless of
    // the apartment type.
    HRESULT init_hr = RoInitialize(RO_INIT_MULTITHREADED);
    if (FAILED(init_hr)) {
      std::cerr << "[LoopbackCapturer] RoInitialize failed: 0x"
                << std::hex << init_hr << "\n";
      SetEvent(done_event);
      return;
    }

    auto* handler = new ActivationCompletionHandler();

    AUDIOCLIENT_ACTIVATION_PARAMS ap = {};
    ap.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    if (target_pid_ != 0) {
      // Isolate audio from a specific application.
      ap.ProcessLoopbackParams.TargetProcessId   = target_pid_;
      ap.ProcessLoopbackParams.ProcessLoopbackMode =
          PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;
    } else {
      // Capture all system audio (exclude only our own process).
      // TargetProcessId=0 returns E_INVALIDARG; use self PID instead.
      ap.ProcessLoopbackParams.TargetProcessId   = GetCurrentProcessId();
      ap.ProcessLoopbackParams.ProcessLoopbackMode =
          PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE;
    }

    PROPVARIANT pv;
    PropVariantInit(&pv);
    pv.vt             = VT_BLOB;
    pv.blob.cbSize    = sizeof(ap);
    pv.blob.pBlobData = reinterpret_cast<BYTE*>(&ap);

    IActivateAudioInterfaceAsyncOperation* async_op = nullptr;
    HRESULT hr = ActivateAudioInterfaceAsync(
        VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
        __uuidof(IAudioClient), 
        &pv, 
        handler,
        &async_op
      );

    if (FAILED(hr)) {
      std::cerr << "[LoopbackCapturer] ActivateAudioInterfaceAsync failed: 0x"
                << std::hex << hr << "\n";
      handler->Release();
      RoUninitialize();
      SetEvent(done_event);
      return;
    }


    // Failed to create the event in the handler — can't continue.
    // Abort the activation attempt and clean up, which will cause the callback to never fire.
    if (!handler->event_) {
      std::cerr << "[LoopbackCapturer] CreateEvent failed for activation handler.\n";
      handler->Release();
      RoUninitialize();
      SetEvent(done_event);
      return;
    }
    // MTA: the callback fires on a threadpool thread — no message pump needed.
    // wait for the callback to signal completion (or timeout after 5 seconds, which
    // should never happen under normal circumstances).
    WaitForSingleObject(handler->event_.get(), 5000);
    if (async_op) async_op->Release();

    if (FAILED(handler->activation_result_) || !handler->client_) {
      std::cerr << "[LoopbackCapturer] Activation completed with error: 0x"
                << std::hex << handler->activation_result_ << "\n";
      handler->Release();
      RoUninitialize();
      SetEvent(done_event);
      return;
    }

    IAudioClient* client = handler->client_;
    handler->Release();

    // GetMixFormat is not supported on the loopback IAudioClient (E_NOTIMPL).
    // Instead, get the system mix format from the default render endpoint.
    WAVEFORMATEX* fmt = nullptr;
    {
      IMMDeviceEnumerator* enumerator = nullptr;
      IMMDevice*           device     = nullptr;
      IAudioClient*        rc         = nullptr;
      HRESULT fmt_hr = CoCreateInstance(
          __uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
          IID_PPV_ARGS(&enumerator));
      if (SUCCEEDED(fmt_hr))
        fmt_hr = enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &device);
      if (SUCCEEDED(fmt_hr))
        fmt_hr = device->Activate(__uuidof(IAudioClient), CLSCTX_ALL,
                                  nullptr, reinterpret_cast<void**>(&rc));
      if (SUCCEEDED(fmt_hr))
        fmt_hr = rc->GetMixFormat(&fmt);
      if (rc)        rc->Release();
      if (device)    device->Release();
      if (enumerator) enumerator->Release();
      if (FAILED(fmt_hr) || !fmt) {
        std::cerr << "[LoopbackCapturer] GetMixFormat (render endpoint) failed: 0x"
                  << std::hex << fmt_hr << "\n";
        client->Release();
        RoUninitialize();
        SetEvent(done_event);
        return;
      }
    }

    // Try IAudioClient3 to query the minimum engine period and use it as the
    // buffer-duration hint.  This reduces capture latency without the risk of
    // InitializeSharedAudioStream (which does not support loopback flags).
    // Falls back gracefully to hnsBufferDuration=0 if IAudioClient3 is
    // unavailable or the query fails.
    REFERENCE_TIME buffer_duration = 0;
    {
      IAudioClient3* client3 = nullptr;
      if (SUCCEEDED(client->QueryInterface(IID_PPV_ARGS(&client3)))) {
        UINT32 default_period = 0, fundamental_period = 0,
               min_period = 0,     max_period = 0;
        if (SUCCEEDED(client3->GetSharedModeEnginePeriod(
                fmt, &default_period, &fundamental_period,
                &min_period, &max_period))) {
          // Convert frames -> 100-ns units.
          buffer_duration = static_cast<REFERENCE_TIME>(
              10000000LL * min_period / fmt->nSamplesPerSec);
          // std::cout << "[LoopbackCapturer] IAudioClient3 min period: "
          //           << min_period << " frames ("
          //           << buffer_duration / 10000 << " ms).\n";
        }
        client3->Release();
      }
    }

    hr = client->Initialize(
        AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
        buffer_duration, 0, fmt, nullptr);
    if (FAILED(hr)) {
      std::cerr << "[LoopbackCapturer] IAudioClient::Initialize failed: 0x"
                << std::hex << hr << "\n";
      CoTaskMemFree(fmt);
      client->Release();
      RoUninitialize();
      SetEvent(done_event);
      return;
    }

    result.client = client;
    result.fmt    = fmt;
    // std::cout << "[LoopbackCapturer] ApplicationLoopback active.\n";
    RoUninitialize();
    SetEvent(done_event);
  });

  WaitForSingleObject(done_event, 7000);
  CloseHandle(done_event);
  worker.join();

  if (!result.client) return nullptr;
  mix_format_ = result.fmt;
  return result.client;
}

// ---------------------------------------------------------------------------
// StartMic
// Opens the default capture endpoint as mono int16 at the loopback sample rate.
// AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM lets the engine resample/convert the
// device's native format to ours, so no manual resampling is required.
// ---------------------------------------------------------------------------
bool ApplicationLoopbackCapturer::StartMic() {
  struct Result {
    IAudioClient*        client = nullptr;
    IAudioCaptureClient* cap    = nullptr;
    HANDLE               ev     = nullptr;
  };
  Result result;
  HANDLE done = CreateEvent(nullptr, FALSE, FALSE, nullptr);
  const int rate = cached_sample_rate_;
  const std::string want_id = mic_device_id_;

  std::thread worker([&result, done, rate, want_id]() {
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);

    IMMDeviceEnumerator* enumerator = nullptr;
    IMMDevice*           device     = nullptr;
    HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr,
                                  CLSCTX_ALL, IID_PPV_ARGS(&enumerator));
    if (FAILED(hr)) {
      std::cerr << "[MicCapture] CoCreateInstance failed: 0x" << std::hex << hr
                << "\n";
      CoUninitialize();
      SetEvent(done);
      return;
    }

    // 优先按用户选中的设备 id 打开；找不到再退回系统默认输入设备。
    if (!want_id.empty()) {
      IMMDeviceCollection* collection = nullptr;
      if (SUCCEEDED(enumerator->EnumAudioEndpoints(
              eCapture, DEVICE_STATE_ACTIVE, &collection)) &&
          collection) {
        std::wstring target;
        int wlen = MultiByteToWideChar(CP_UTF8, 0, want_id.c_str(), -1, nullptr, 0);
        if (wlen > 0) {
          target.resize(wlen - 1);
          MultiByteToWideChar(CP_UTF8, 0, want_id.c_str(), -1, &target[0], wlen);
        }
        UINT count = 0;
        collection->GetCount(&count);
        for (UINT i = 0; i < count; ++i) {
          IMMDevice* dev = nullptr;
          if (FAILED(collection->Item(i, &dev)) || !dev) continue;
          LPWSTR wid = nullptr;
          if (SUCCEEDED(dev->GetId(&wid)) && wid) {
            if (target == wid) device = dev; else dev->Release();
            CoTaskMemFree(wid);
          } else {
            dev->Release();
          }
          if (device) break;
        }
        collection->Release();
      }
    }

    if (!device) {
      hr = enumerator->GetDefaultAudioEndpoint(eCapture, eCommunications, &device);
      if (FAILED(hr))
        hr = enumerator->GetDefaultAudioEndpoint(eCapture, eConsole, &device);
    }
    if (FAILED(hr) || !device) {
      std::cerr << "[MicCapture] GetDefaultAudioEndpoint failed: 0x" << std::hex
                << hr << "\n";
      enumerator->Release();
      CoUninitialize();
      SetEvent(done);
      return;
    }

    IAudioClient* client = nullptr;
    hr = device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr,
                          reinterpret_cast<void**>(&client));
    if (FAILED(hr) || !client) {
      std::cerr << "[MicCapture] Activate failed: 0x" << std::hex << hr << "\n";
      device->Release();
      enumerator->Release();
      CoUninitialize();
      SetEvent(done);
      return;
    }

    WAVEFORMATEX fmt = {};
    fmt.wFormatTag      = WAVE_FORMAT_PCM;
    fmt.nChannels       = 1;
    fmt.nSamplesPerSec  = static_cast<DWORD>(rate);
    fmt.wBitsPerSample  = 16;
    fmt.nBlockAlign     = static_cast<WORD>(fmt.nChannels * fmt.wBitsPerSample / 8);
    fmt.nAvgBytesPerSec = fmt.nSamplesPerSec * fmt.nBlockAlign;
    fmt.cbSize          = 0;

    hr = client->Initialize(
        AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_EVENTCALLBACK |
            AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM |
            AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
        0, 0, &fmt, nullptr);
    if (FAILED(hr)) {
      std::cerr << "[MicCapture] Initialize failed: 0x" << std::hex << hr
                << "\n";
      client->Release();
      device->Release();
      enumerator->Release();
      CoUninitialize();
      SetEvent(done);
      return;
    }

    HANDLE ev = CreateEvent(nullptr, FALSE, FALSE, nullptr);
    if (ev == nullptr || FAILED(client->SetEventHandle(ev))) {
      std::cerr << "[MicCapture] SetEventHandle failed.\n";
      if (ev) CloseHandle(ev);
      client->Release();
      device->Release();
      enumerator->Release();
      CoUninitialize();
      SetEvent(done);
      return;
    }

    IAudioCaptureClient* cap = nullptr;
    if (FAILED(client->GetService(IID_PPV_ARGS(&cap))) || !cap) {
      std::cerr << "[MicCapture] GetService(IAudioCaptureClient) failed.\n";
      CloseHandle(ev);
      client->Release();
      device->Release();
      enumerator->Release();
      CoUninitialize();
      SetEvent(done);
      return;
    }

    if (FAILED(client->Start())) {
      std::cerr << "[MicCapture] IAudioClient::Start failed.\n";
      cap->Release();
      CloseHandle(ev);
      client->Release();
      device->Release();
      enumerator->Release();
      CoUninitialize();
      SetEvent(done);
      return;
    }

    result.client = client;
    result.cap    = cap;
    result.ev     = ev;

    device->Release();
    enumerator->Release();
    CoUninitialize();
    SetEvent(done);
  });

  WaitForSingleObject(done, 5000);
  CloseHandle(done);
  worker.join();

  if (!result.client) return false;
  mic_client_         = result.client;
  mic_capture_client_ = result.cap;
  mic_event_          = result.ev;
  return true;
}

void ApplicationLoopbackCapturer::StopMic() {
  mic_running_ = false;
  if (mic_event_ != nullptr) {
    SetEvent(mic_event_);
  }
  if (mic_thread_.joinable()) {
    mic_thread_.join();
  }
  if (mic_client_) {
    mic_client_->Stop();
  }
  if (mic_capture_client_) {
    mic_capture_client_->Release();
    mic_capture_client_ = nullptr;
  }
  if (mic_client_) {
    mic_client_->Release();
    mic_client_ = nullptr;
  }
  if (mic_event_ != nullptr) {
    CloseHandle(mic_event_);
    mic_event_ = nullptr;
  }
  mic_ok_ = false;
}

// ---------------------------------------------------------------------------
// MicThread
// Reads the capture endpoint's packets (already mono int16 at `rate` thanks to
// AUTOCONVERTPCM) into mic_ring_.  FeederThread mixes them into the frame.
// ---------------------------------------------------------------------------
void ApplicationLoopbackCapturer::MicThread() {
  CoInitializeEx(nullptr, COINIT_MULTITHREADED);

  DWORD task_index = 0;
  HANDLE task = AvSetMmThreadCharacteristicsW(L"Audio", &task_index);

  const size_t out_channels = 1;

  while (mic_running_) {
    DWORD wait_result = WaitForSingleObject(mic_event_, /*dwMilliseconds=*/200);
    if (!mic_running_) break;
    if (wait_result == WAIT_TIMEOUT) continue;
    if (wait_result != WAIT_OBJECT_0) break;

    UINT32 packet_size = 0;
    while (mic_capture_client_ &&
           SUCCEEDED(mic_capture_client_->GetNextPacketSize(&packet_size)) &&
           packet_size > 0) {
      BYTE*  data   = nullptr;
      UINT32 frames = 0;
      DWORD  flags  = 0;

      if (FAILED(mic_capture_client_->GetBuffer(&data, &frames, &flags, nullptr,
                                                nullptr))) {
        break;
      }

      if (frames > 0) {
        const bool silent = (flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0;
        std::lock_guard<std::mutex> lock(mic_mutex_);
        for (size_t f = 0; f < frames; ++f) {
          if (mic_frames_avail_ >= mic_capacity_frames_) {
            mic_read_frame_ = (mic_read_frame_ + 1) % mic_capacity_frames_;
            --mic_frames_avail_;
          }
          int16_t s = 0;
          if (!silent) {
            s = *reinterpret_cast<const int16_t*>(
                data + f * out_channels * sizeof(int16_t));
          }
          mic_ring_[mic_write_frame_] = s;
          mic_write_frame_ = (mic_write_frame_ + 1) % mic_capacity_frames_;
          ++mic_frames_avail_;
        }
      }
      mic_capture_client_->ReleaseBuffer(frames);
    }
  }

  if (task) AvRevertMmThreadCharacteristics(task);
  CoUninitialize();
}

// ---------------------------------------------------------------------------
// CaptureThread
// Reads WASAPI packets, converts to int16 mono, and writes to the ring
// buffer.  It does NOT call CaptureFrame — that is FeederThread's job.
// This decouples the WASAPI callback timing from the WebRTC audio thread,
// preventing the AudioSendStream race-checker crash.
// ---------------------------------------------------------------------------
void ApplicationLoopbackCapturer::CaptureThread() {
  CoInitializeEx(nullptr, COINIT_MULTITHREADED);

  DWORD task_index = 0;
  HANDLE task = AvSetMmThreadCharacteristicsW(L"Audio", &task_index);

  const size_t in_channels   = mix_format_->nChannels;
  const size_t out_channels  = cached_out_channels_;
  const int    bits          = mix_format_->wBitsPerSample;

  bool is_float = (mix_format_->wFormatTag == WAVE_FORMAT_IEEE_FLOAT);
  if (mix_format_->wFormatTag == WAVE_FORMAT_EXTENSIBLE) {
    auto* ext = reinterpret_cast<WAVEFORMATEXTENSIBLE*>(mix_format_);
    static const GUID kSubtypeFloat = {
        0x00000003, 0x0000, 0x0010,
        {0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71}};
    is_float = (ext->SubFormat == kSubtypeFloat);
  }

  // std::cout << "[LoopbackCapturer] CaptureThread format: "
  //           << (is_float ? "float" : "int") << bits
  //           << " -> int16 (" << in_channels << " ch in -> "
  //           << out_channels << " ch out).\n";

  // 1. Assign the correct extractor function pointer
  SampleExtractor extractor = ExtractInt16; // default fallback
  if (is_float && bits == 32) {
    extractor = ExtractFloat32;
  } else if (!is_float && bits == 32) {
    extractor = ExtractInt32;
  } else if (!is_float && bits == 24) {
    extractor = ExtractInt24;
  }

  // 2. Calculate exactly how many bytes to jump per sample
  const size_t bytes_per_sample = bits / 8;

  // Temporary conversion buffer (reused across packets).
  std::vector<int16_t> conv;

  while (running_) {
    DWORD wait_result =
        WaitForSingleObject(buffer_ready_event_, /*dwMilliseconds=*/200);
    if (!running_) break;
    if (wait_result == WAIT_TIMEOUT) continue;
    if (wait_result != WAIT_OBJECT_0) break;

    UINT32 packet_size = 0;
    while (SUCCEEDED(capture_client_->GetNextPacketSize(&packet_size)) &&
           packet_size > 0) {
      BYTE*  data       = nullptr;
      UINT32 num_frames = 0;
      DWORD  flags      = 0;

      HRESULT hr = capture_client_->GetBuffer(&data, &num_frames, &flags,
                                              nullptr, nullptr);
      if (FAILED(hr)) break;

      if (num_frames > 0) {
        // For silent packets write zeros; for real packets convert to int16.
        // Either way we push frames into the ring so the feeder clock never
        // stalls during quiet periods.
        const bool silent = (flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0;
        if (!silent) {
          conv.resize(num_frames * out_channels);
          
          for (size_t f = 0; f < num_frames; ++f) {
            // Find the start of this frame in the raw WASAPI buffer
            const BYTE* frame_ptr = data + (f * in_channels * bytes_per_sample);
            
            // Extract the Left channel
            int16_t left = extractor(frame_ptr);
            
            // Extract the Right channel (or duplicate Left if mono input)
            int16_t right = (in_channels > 1) 
                ? extractor(frame_ptr + bytes_per_sample) 
                : left;
                
            // Write to our stereo output buffer
            conv[f] = static_cast<int16_t>((static_cast<int32_t>(left) + right) / 2);
          }
        }
        {
          std::lock_guard<std::mutex> lock(ring_mutex_);
          for (size_t f = 0; f < num_frames; ++f) {
            if (ring_frames_avail_ >= ring_capacity_frames_) {
              ring_read_frame_ = (ring_read_frame_ + 1) % ring_capacity_frames_;
              --ring_frames_avail_;
            }
            const size_t write_pos = ring_write_frame_ * out_channels;
            if (silent) {
              std::memset(ring_buf_.data() + write_pos, 0,
                          out_channels * sizeof(int16_t));
            } else {
              std::memcpy(ring_buf_.data() + write_pos,
                          conv.data() + f * out_channels,
                          out_channels * sizeof(int16_t));
            }
            ring_write_frame_ = (ring_write_frame_ + 1) % ring_capacity_frames_;
            ++ring_frames_avail_;
          }
        }
      }
      capture_client_->ReleaseBuffer(num_frames);
    }
  }

  if (task) AvRevertMmThreadCharacteristics(task);
  CoUninitialize();
}

// ---------------------------------------------------------------------------
// FeederThread
// Fires every 20 ms via a waitable timer (wall-clock paced) and calls
// CaptureFrame with exactly frames_per_20ms samples from the ring buffer.
//
// Jitter-buffer design (motivated by test_capture_wav diagnostics):
//   WASAPI loopback routinely stalls for 20-80 ms and then delivers multiple
//   batched 10 ms packets at once.  The previous 50 ms latency cap left only
//   ~0-20 ms pre-buffered, so a 72 ms WASAPI stall emptied the ring and caused
//   ~70 ms of silence to be sent to WebRTC (= audible chop).
//
//   Fix: pre-buffer 160 ms on startup before the first CaptureFrame call.
//   In steady state the ring holds ~160 ms of audio, so a 72 ms WASAPI stall
//   only drains the ring to ~88 ms -- still above the 50 ms starvation floor,
//   meaning zero silence is emitted.  A 200 ms hard cap prevents unbounded
//   latency growth after extended stalls or CPU spikes.
// ---------------------------------------------------------------------------
void ApplicationLoopbackCapturer::FeederThread() {
  CoInitializeEx(nullptr, COINIT_MULTITHREADED);

  DWORD task_index = 0;
  HANDLE task = AvSetMmThreadCharacteristicsW(L"Audio", &task_index);

  const int    sample_rate     = cached_sample_rate_;
  const size_t out_channels    = 1;

  // 480 samples = one 10 ms frame at 48 kHz.
  const size_t frames_per_10ms = static_cast<size_t>(sample_rate) / 100;

  // Jitter-buffer thresholds (all in frames).
  const size_t target_prebuf  = 16 * frames_per_10ms;  // 160 ms startup fill
  const size_t max_buffered   = 20 * frames_per_10ms;  // 200 ms hard cap

  // Stereo ring-read buffer
  std::vector<int16_t> feed(frames_per_10ms * out_channels, int16_t{0});

  // true until the ring has at least 160 ms buffered.
  bool prebuffering = true;

  // Feeder diagnostics.
  using FClock = std::chrono::steady_clock;
  auto     last_tick_time = FClock::now();
  bool     first_tick     = true;
  uint64_t tick_count     = 0;
  uint32_t w_silence      = 0;  // ticks where CaptureFrame got all-zero feed
  uint32_t w_drain        = 0;  // ticks where ring was empty
  uint32_t w_partial      = 0;  // ticks where ring had < frames_per_20ms
  uint32_t w_cap_drops    = 0;  // frames dropped by hard cap this window
  double   w_isum         = 0.0;
  double   w_imin         = 1e9;
  double   w_imax         = 0.0;

  // Periodic auto-reset waitable timer -- fires every 10 ms.
  HANDLE timer = CreateWaitableTimerW(nullptr, /*bManualReset=*/FALSE, nullptr);
  LARGE_INTEGER due = {};
  due.QuadPart = -100000LL;  // 10 ms initial delay (100-ns units)
  SetWaitableTimer(timer, &due, /*lPeriod_ms=*/10, nullptr, nullptr, FALSE);

  timeBeginPeriod(10);

  // Drift compensation: track wall-clock vs. delivered frames so we never
  // feed audio faster than real-time (which would steadily overfill the
  // receiver's jitter buffer and cause it to flush).
  auto     feeder_start       = FClock::now();
  bool     feeder_start_valid = false;  // true after startup prebuffering
  int64_t  total_frames_del   = 0;     // frames delivered since prebuf end
  uint32_t w_drift_skips      = 0;     // ticks skipped this stats window

  while (running_) {
    if (WaitForSingleObject(timer, /*timeout_ms=*/40) == WAIT_FAILED) break;
    if (!running_) break;

    // Measure actual timer interval.
    {
      auto   tnow = FClock::now();
      double intv = std::chrono::duration<double,std::milli>(
                        tnow - last_tick_time).count();
      last_tick_time = tnow;
      if (!first_tick) {
        w_isum += intv;
        if (intv < w_imin) w_imin = intv;
        if (intv > w_imax) w_imax = intv;
      }
      first_tick = false;
      ++tick_count;
    }

    std::fill(feed.begin(), feed.end(), int16_t{0});

    // Drift compensation: if we have delivered more than one 20-ms packet
    // worth of frames ahead of real-time, skip this tick entirely (do NOT
    // consume from the ring and do NOT call CaptureFrame).  This keeps the
    // RTP send rate at exactly the nominal sample rate.
    if (feeder_start_valid) {
      const auto   now_dc      = FClock::now();
      const double elapsed_sec =
          std::chrono::duration<double>(now_dc - feeder_start).count();
      const int64_t expected_frm =
          static_cast<int64_t>(elapsed_sec * sample_rate);
      if (total_frames_del >
          expected_frm + static_cast<int64_t>(frames_per_10ms)) {
        ++w_drift_skips;
        continue;
      }
    }

    size_t ring_snap    = 0;
    bool   tick_drain   = false;
    bool   tick_partial = false;
    {
      std::lock_guard<std::mutex> lock(ring_mutex_);

      // Hard cap: trim oldest frames to keep latency under 200 ms.
      if (ring_frames_avail_ > max_buffered) {
        const size_t drop = ring_frames_avail_ - max_buffered;
        ring_read_frame_ = (ring_read_frame_ + drop) % ring_capacity_frames_;
        ring_frames_avail_ -= drop;
        w_cap_drops += static_cast<uint32_t>(drop);
        // std::cout << "[LoopbackFeeder] Hard-cap: dropped "
        //           << drop << " frames ("
        //           << (drop * 1000 / static_cast<size_t>(sample_rate))
        //           << " ms)\n";
      }

      // Startup pre-buffering: wait until the ring has 160 ms of audio.
      if (prebuffering) {
        if (ring_frames_avail_ >= target_prebuf) {
          prebuffering = false;
          feeder_start       = FClock::now();  // start drift clock NOW
          feeder_start_valid = true;
          // std::cout << "[LoopbackCapturer] Pre-buffer ready ("
          //           << (target_prebuf * 1000 / static_cast<size_t>(sample_rate))
          //           << " ms), starting audio output.\n";
        } else {
          continue;  // still accumulating — skip CaptureFrame this tick
        }
      }

      ring_snap = ring_frames_avail_;

      // Consume up to 10 ms from the ring each tick.
      if (ring_frames_avail_ > 0) {
        const size_t to_copy =
            (ring_frames_avail_ < frames_per_10ms) ? ring_frames_avail_
                                                   : frames_per_10ms;
        if (to_copy < frames_per_10ms) tick_partial = true;
        for (size_t f = 0; f < to_copy; ++f) {
          const size_t rp = ring_read_frame_ * out_channels;
          std::memcpy(feed.data() + f * out_channels,
                      ring_buf_.data() + rp,
                      out_channels * sizeof(int16_t));
          ring_read_frame_ = (ring_read_frame_ + 1) % ring_capacity_frames_;
        }
        ring_frames_avail_ -= to_copy;
      } else {
        tick_drain = true;
      }
    }

    // 混入麦克风：与 loopback 同采样率/单声道 int16，直接相加并限幅。
    if (mic_ok_) {
      std::lock_guard<std::mutex> lock(mic_mutex_);
      const size_t n = (mic_frames_avail_ < frames_per_10ms)
                           ? mic_frames_avail_
                           : frames_per_10ms;
      for (size_t f = 0; f < n; ++f) {
        int32_t mixed = static_cast<int32_t>(feed[f]) +
                        static_cast<int32_t>(mic_ring_[mic_read_frame_]);
        if (mixed > 32767) {
          mixed = 32767;
        } else if (mixed < -32768) {
          mixed = -32768;
        }
        feed[f] = static_cast<int16_t>(mixed);
        mic_read_frame_ = (mic_read_frame_ + 1) % mic_capacity_frames_;
      }
      mic_frames_avail_ -= n;
    }

    // Confirm whether the feed we're pushing is all-zero (silence).
    bool feed_silent = true;
    for (const int16_t s : feed) {
      if (s != 0) { feed_silent = false; break; }
    }
    if (feed_silent) ++w_silence;
    if (tick_drain) {
      ++w_drain;
      // std::cout << "[LoopbackFeeder] Ring drained — sending silence.\n";
    }
    if (tick_partial) ++w_partial;

    if (source_) {
      source_->CaptureFrame(feed.data(), /*bits_per_sample=*/16,
                            sample_rate, out_channels, frames_per_10ms);
      total_frames_del += static_cast<int64_t>(frames_per_10ms);
    }

    // Every 50 ticks (≈ 500 ms at 10 ms/tick) print a summary.
    // if (tick_count % 50 == 0) {
    //   const double avg_ms = (w_isum > 0.0) ? (w_isum / 49.0) : 20.0;
    //   std::cout << "[LoopbackFeeder] 1s summary"
    //             << " | timer avg=" << avg_ms
    //             << " min=" << w_imin << " max=" << w_imax << " ms"
    //             << " | ring=" << (ring_snap * 1000 / static_cast<size_t>(sample_rate)) << " ms"
    //             << " | silence=" << w_silence
    //             << " drain=" << w_drain
    //             << " partial=" << w_partial << "/50"
    //             << " | cap_drops=" << w_cap_drops
    //             << " drift_skips=" << w_drift_skips << "\n";
    //   w_silence = w_drain = w_partial = w_cap_drops = w_drift_skips = 0;
    //   w_isum = 0.0; w_imin = 1e9; w_imax = 0.0;
    // }
  }

  CancelWaitableTimer(timer);
  CloseHandle(timer);
  timeEndPeriod(10);
  if (task) AvRevertMmThreadCharacteristics(task);
  CoUninitialize();
}

}  // namespace flutter_webrtc_plugin

#endif  // _WIN32
