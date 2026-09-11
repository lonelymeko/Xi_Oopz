package com.example.oopz_flutter_client

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager

/**
 * 语音连麦后台保活前台服务。
 *
 * 为什么不用 flutter_foreground_task：该插件固定用
 * ServiceInfo.FOREGROUND_SERVICE_TYPE_MANIFEST 启动前台服务，等于把 manifest 里声明的
 * 所有类型一次性带上去。Android 14(API 34) 起，带 mediaProjection 类型启动前台服务
 * 必须先拿到屏幕采集授权（android:project_media），否则 startForeground 直接抛
 * SecurityException，整个前台服务起不来 —— 结果就是「只是进语音频道挂后台，几秒后
 * 麦克风被系统收回/进程被冻结，通话断开」。
 *
 * 所以这里改成自己控制类型位掩码：
 * - 进语音频道：microphone | mediaPlayback（此时不需要、也不能带 mediaProjection）
 * - 用户授权屏幕采集后：再补一次 startForeground 带上 mediaProjection
 * - 停止共享：降级回 microphone | mediaPlayback
 *
 * 同时持有 PARTIAL_WAKE_LOCK 与 WIFI high-perf 锁，保证息屏/后台时网络与音频线程
 * 不被挂起；常驻通知文案由 Dart 侧下发（如「正在连麦中」/「正在共享屏幕」）。
 */
class CallForegroundService : Service() {

    companion object {
        const val CHANNEL_ID = "oopz_voice_keepalive"
        const val NOTIFICATION_ID = 1001

        const val ACTION_START = "com.example.oopz_flutter_client.action.START"
        const val ACTION_STOP = "com.example.oopz_flutter_client.action.STOP"

        const val EXTRA_TITLE = "title"
        const val EXTRA_TEXT = "text"
        const val EXTRA_SCREEN_SHARING = "screenSharing"

        // ServiceInfo.FOREGROUND_SERVICE_TYPE_* 的数值（避免在低版本上引用 API 29 常量）。
        private const val TYPE_MEDIA_PLAYBACK = 0x00000002
        private const val TYPE_MEDIA_PROJECTION = 0x00000020
        private const val TYPE_MICROPHONE = 0x00000080

        @Volatile
        var isRunning: Boolean = false
            private set

        /** 启动或更新前台服务；[screenSharing] 决定是否带上 mediaProjection 类型。 */
        fun start(context: Context, title: String, text: String, screenSharing: Boolean) {
            val intent = Intent(context, CallForegroundService::class.java).apply {
                action = ACTION_START
                putExtra(EXTRA_TITLE, title)
                putExtra(EXTRA_TEXT, text)
                putExtra(EXTRA_SCREEN_SHARING, screenSharing)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        /** 停止前台服务并移除通知（离开语音频道/退出登录时调用）。 */
        fun stop(context: Context) {
            context.stopService(Intent(context, CallForegroundService::class.java))
        }
    }

    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }

        val title = intent?.getStringExtra(EXTRA_TITLE) ?: "Oopz Live"
        val text = intent?.getStringExtra(EXTRA_TEXT) ?: "正在连麦中"
        val screenSharing = intent?.getBooleanExtra(EXTRA_SCREEN_SHARING, false) ?: false

        try {
            startForegroundCompat(buildNotification(title, text), requestedTypes(screenSharing))
            isRunning = true
            acquireLocks()
        } catch (e: Exception) {
            // 前台服务起不来会直接影响保活：记录后把服务标记为未运行，交由下一轮重试。
            isRunning = false
            android.util.Log.e("OOPZ-FGS", "startForeground failed", e)
        }

        // 进程被系统回收后自动重建，重建时按语音（不含 mediaProjection）恢复。
        return START_STICKY
    }

    override fun onDestroy() {
        isRunning = false
        releaseLocks()
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                stopForeground(STOP_FOREGROUND_REMOVE)
            } else {
                @Suppress("DEPRECATION")
                stopForeground(true)
            }
        } catch (_: Exception) {
        }
        super.onDestroy()
    }

    // ------------------------------------------------------------------
    // 前台服务类型
    // ------------------------------------------------------------------

    private fun requestedTypes(screenSharing: Boolean): Int {
        // mediaPlayback 始终保留（远端音频播放）。
        var types = TYPE_MEDIA_PLAYBACK
        // 只有拿到录音权限才带 microphone，否则 Android 14 会因缺少运行时权限拒绝启动。
        if (hasRecordAudioPermission()) types = types or TYPE_MICROPHONE
        // 屏幕共享必须等用户授权后才会调用到这里，此时再带 mediaProjection 才合法。
        if (screenSharing) types = types or TYPE_MEDIA_PROJECTION
        return types
    }

    private fun hasRecordAudioPermission(): Boolean {
        return checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED
    }

    /**
     * 带类型启动前台服务。若某个类型因运行时前提不满足（如 mediaProjection 无授权、
     * microphone 无录音权限）而抛 SecurityException，则逐步降级重试，保证服务本身
     * 一定能起来、语音保活不被拖垮。
     */
    private fun startForegroundCompat(notification: Notification, requested: Int) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            @Suppress("DEPRECATION")
            startForeground(NOTIFICATION_ID, notification)
            return
        }

        val candidates = LinkedHashSet<Int>()
        candidates.add(requested)
        var trimmed = requested
        if (trimmed and TYPE_MEDIA_PROJECTION != 0) {
            trimmed = trimmed and TYPE_MEDIA_PROJECTION.inv()
            candidates.add(trimmed)
        }
        if (trimmed and TYPE_MICROPHONE != 0) {
            trimmed = trimmed and TYPE_MICROPHONE.inv()
            candidates.add(trimmed)
        }
        candidates.add(TYPE_MEDIA_PLAYBACK)

        var lastError: Exception? = null
        for (candidate in candidates) {
            val types = if (candidate == 0) TYPE_MEDIA_PLAYBACK else candidate
            try {
                startForeground(NOTIFICATION_ID, notification, types)
                return
            } catch (e: Exception) {
                lastError = e
            }
        }
        throw lastError ?: IllegalStateException("startForeground failed")
    }

    // ------------------------------------------------------------------
    // 通知
    // ------------------------------------------------------------------

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            "Oopz 语音保活",
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = "保持语音连麦在后台运行"
            setShowBadge(false)
            enableLights(false)
            enableVibration(false)
        }
        manager.createNotificationChannel(channel)
    }

    private fun buildNotification(title: String, text: String): Notification {
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        } else {
            PendingIntent.FLAG_UPDATE_CURRENT
        }
        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
        val contentIntent = launchIntent?.let { PendingIntent.getActivity(this, 0, it, flags) }

        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        builder
            .setContentTitle(title)
            .setContentText(text)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setOngoing(true)
            .setShowWhen(false)
            .setOnlyAlertOnce(true)
            .setCategory(Notification.CATEGORY_CALL)

        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            @Suppress("DEPRECATION")
            builder.setPriority(Notification.PRIORITY_LOW)
        }
        contentIntent?.let { builder.setContentIntent(it) }
        return builder.build()
    }

    // ------------------------------------------------------------------
    // Wake / Wifi 锁
    // ------------------------------------------------------------------

    private fun acquireLocks() {
        try {
            if (wakeLock == null) {
                val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
                wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "oopz:voice").apply {
                    setReferenceCounted(false)
                }
            }
            if (wakeLock?.isHeld == false) wakeLock?.acquire()
        } catch (_: Exception) {
        }

        try {
            if (wifiLock == null) {
                val wm = getSystemService(Context.WIFI_SERVICE) as WifiManager
                wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "oopz:voice").apply {
                    setReferenceCounted(false)
                }
            }
            if (wifiLock?.isHeld == false) wifiLock?.acquire()
        } catch (_: Exception) {
        }
    }

    private fun releaseLocks() {
        try {
            if (wakeLock?.isHeld == true) wakeLock?.release()
        } catch (_: Exception) {
        }
        try {
            if (wifiLock?.isHeld == true) wifiLock?.release()
        } catch (_: Exception) {
        }
        wakeLock = null
        wifiLock = null
    }
}
