# R8 / ProGuard 规则（release 构建）

# Flutter engine
-keep class io.flutter.** { *; }
-dontwarn io.flutter.**

# flutter_webrtc / WebRTC（大量 JNI 反射调用，必须保留）
-keep class org.webrtc.** { *; }
-keep class com.cloudwebrtc.webrtc.** { *; }
-dontwarn org.webrtc.**
-dontwarn com.cloudwebrtc.webrtc.**

# flutter_foreground_task 已弃用；保留 Flutter 插件注册
-keep class io.flutter.plugins.** { *; }
-keep class com.pravera.** { *; }

# url_launcher / window_manager / media_kit 等插件
-keep class com.example.oopz_flutter_client.** { *; }

# 保留 Parcelable / Serializable
-keepclassmembers class * implements android.os.Parcelable {
    public static final android.os.Parcelable$Creator *;
}
-keepclassmembers class * implements java.io.Serializable { *; }
