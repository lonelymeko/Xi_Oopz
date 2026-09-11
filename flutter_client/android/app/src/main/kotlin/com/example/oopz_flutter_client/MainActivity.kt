package com.example.oopz_flutter_client

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {
    private val foregroundChannel = "oopz/foreground"
    private val notificationPermissionRequestCode = 9101

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, foregroundChannel)
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "start" -> {
                        val title = call.argument<String>("title") ?: "Oopz Live"
                        val text = call.argument<String>("text") ?: "正在连麦中"
                        val screenSharing = call.argument<Boolean>("screenSharing") ?: false
                        ensureNotificationPermission()
                        CallForegroundService.start(applicationContext, title, text, screenSharing)
                        result.success(true)
                    }

                    "stop" -> {
                        CallForegroundService.stop(applicationContext)
                        result.success(true)
                    }

                    "isRunning" -> result.success(CallForegroundService.isRunning)
                    else -> result.notImplemented()
                }
            }
    }

    /** Android 13+ 需要 POST_NOTIFICATIONS 才能显示常驻通知；进语音时在 Activity 内请求。 */
    private fun ensureNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
        ) {
            return
        }
        requestPermissions(
            arrayOf(Manifest.permission.POST_NOTIFICATIONS),
            notificationPermissionRequestCode,
        )
    }
}
