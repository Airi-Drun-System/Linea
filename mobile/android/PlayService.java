package com.vegasdev.linea;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;

// служба «играет музыка»: держит Linea живой в фоне и показывает уведомление с кнопками
public class PlayService extends Service {
    private static final String CH = "linea_play";

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String act = intent == null ? null : intent.getAction();
        if (act != null) { // нажали кнопку в уведомлении
            LineaPlugin.cmd(act);
            return START_NOT_STICKY;
        }
        if (intent == null) { stopSelf(); return START_NOT_STICKY; }
        boolean playing = intent.getBooleanExtra("playing", false);
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CH) == null) {
            NotificationChannel c = new NotificationChannel(CH, "Музыка", NotificationManager.IMPORTANCE_LOW);
            c.setShowBadge(false);
            nm.createNotificationChannel(c);
        }
        int fl = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), fl);
        Notification n = new NotificationCompat.Builder(this, CH)
            .setSmallIcon(R.drawable.ic_stat_linea)
            .setContentTitle(intent.getStringExtra("title"))
            .setContentText(intent.getStringExtra("artist"))
            .setContentIntent(open)
            .setOngoing(playing)
            .setSilent(true)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .addAction(0, "Назад", btn("prev", 1))
            .addAction(0, playing ? "Пауза" : "Играть", btn("toggle", 2))
            .addAction(0, "Дальше", btn("next", 3))
            .build();
        if (Build.VERSION.SDK_INT >= 29) startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        else startForeground(1, n);
        // на паузе отпускаем: уведомление можно смахнуть, телефон не держит Linea зря
        if (!playing) ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_DETACH);
        return START_NOT_STICKY;
    }

    private PendingIntent btn(String act, int code) {
        return PendingIntent.getService(this, code, new Intent(this, PlayService.class).setAction(act), PendingIntent.FLAG_IMMUTABLE);
    }
}
