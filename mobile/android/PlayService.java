package com.vegasdev.linea;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Build;
import android.os.IBinder;
import android.support.v4.media.MediaMetadataCompat;
import android.support.v4.media.session.MediaSessionCompat;
import android.support.v4.media.session.PlaybackStateCompat;
import android.util.Base64;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;

// служба «играет музыка»: держит Linea живой в фоне, показывает плеер в шторке и на экране блокировки.
// MediaSession — это то, что видят система, «динамический остров», часы и наушники: название, обложка, время, кнопки
public class PlayService extends Service {
    private static final String CH = "linea_play";
    private static MediaSessionCompat session;
    private String artSrc = "";
    private Bitmap art;

    @Override
    public IBinder onBind(Intent intent) { return null; }

    private MediaSessionCompat session() {
        if (session != null) return session;
        session = new MediaSessionCompat(this, "Linea");
        session.setCallback(new MediaSessionCompat.Callback() {
            @Override public void onPlay() { LineaPlugin.cmd("play"); }
            @Override public void onPause() { LineaPlugin.cmd("pause"); }
            @Override public void onSkipToNext() { LineaPlugin.cmd("next"); }
            @Override public void onSkipToPrevious() { LineaPlugin.cmd("prev"); }
            @Override public void onSeekTo(long pos) { LineaPlugin.cmd("seek:" + pos); }
        });
        session.setActive(true);
        return session;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String act = intent == null ? null : intent.getAction();
        if (act != null) { // нажали кнопку в уведомлении
            LineaPlugin.cmd(act);
            return START_NOT_STICKY;
        }
        if (intent == null) { stopSelf(); return START_NOT_STICKY; }
        boolean playing = intent.getBooleanExtra("playing", false);
        String title = intent.getStringExtra("title"), artist = intent.getStringExtra("artist");
        long pos = intent.getLongExtra("pos", 0), dur = intent.getLongExtra("dur", 0);
        String a = intent.getStringExtra("art");
        if (a != null && !a.isEmpty() && !a.equals(artSrc)) {
            try { byte[] b = Base64.decode(a, Base64.DEFAULT); art = BitmapFactory.decodeByteArray(b, 0, b.length); artSrc = a; } catch (Exception e) { art = null; }
        }

        MediaSessionCompat s = session();
        MediaMetadataCompat.Builder md = new MediaMetadataCompat.Builder()
            .putString(MediaMetadataCompat.METADATA_KEY_TITLE, title)
            .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, artist)
            .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, dur > 0 ? dur : -1);
        if (art != null) md.putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, art);
        s.setMetadata(md.build());
        s.setPlaybackState(new PlaybackStateCompat.Builder()
            .setActions(PlaybackStateCompat.ACTION_PLAY | PlaybackStateCompat.ACTION_PAUSE | PlaybackStateCompat.ACTION_PLAY_PAUSE
                | PlaybackStateCompat.ACTION_SKIP_TO_NEXT | PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS | PlaybackStateCompat.ACTION_SEEK_TO)
            .setState(playing ? PlaybackStateCompat.STATE_PLAYING : PlaybackStateCompat.STATE_PAUSED, pos, playing ? 1f : 0f)
            .build());

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
            .setLargeIcon(art)
            .setContentTitle(title)
            .setContentText(artist)
            .setContentIntent(open)
            .setOngoing(playing)
            .setSilent(true)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .addAction(android.R.drawable.ic_media_previous, "Назад", btn("prev", 1))
            .addAction(playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play, playing ? "Пауза" : "Играть", btn("toggle", 2))
            .addAction(android.R.drawable.ic_media_next, "Дальше", btn("next", 3))
            .setStyle(new androidx.media.app.NotificationCompat.MediaStyle().setMediaSession(s.getSessionToken()).setShowActionsInCompactView(0, 1, 2))
            .build();
        if (Build.VERSION.SDK_INT >= 29) startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        else startForeground(1, n);
        // на паузе отпускаем: уведомление можно смахнуть, телефон не держит Linea зря
        if (!playing) ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_DETACH);
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        if (session != null) { session.release(); session = null; }
        super.onDestroy();
    }

    private PendingIntent btn(String act, int code) {
        return PendingIntent.getService(this, code, new Intent(this, PlayService.class).setAction(act), PendingIntent.FLAG_IMMUTABLE);
    }
}
