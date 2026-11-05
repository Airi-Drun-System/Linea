package com.vegasdev.linea;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.widget.RemoteViews;
import java.util.Arrays;
import java.util.List;
import java.util.Objects;

// виджет на главном экране — тот же плеер, что в шторке: песню присылает PlayService, кнопки уходят в страницу через LineaPlugin.
// Кнопки — рассылка самому себе, а не запуск службы: Android запрещает запускать службы приложения в фоне
public class LineaWidget extends AppWidgetProvider {
    private static final List<String> ACTS = Arrays.asList("prev", "toggle", "next");
    private static final int[] BTNS = { R.id.w_prev, R.id.w_toggle, R.id.w_next };
    private static String title, artist;
    private static boolean playing;
    private static Bitmap art;

    // title == null — ничего не играет
    static void show(Context c, String t, String a, boolean p, Bitmap b) {
        // перемотка тоже приходит сюда: перерисовываем, только если на виджете что-то поменялось
        if (Objects.equals(t, title) && Objects.equals(a, artist) && p == playing && b == art) return;
        title = t; artist = a; playing = p; art = b;
        draw(c, AppWidgetManager.getInstance(c));
    }

    @Override
    public void onUpdate(Context c, AppWidgetManager m, int[] ids) { draw(c, m); }

    @Override
    public void onReceive(Context c, Intent i) {
        String act = i.getAction();
        if (!ACTS.contains(act)) { super.onReceive(c, i); return; }
        // Linea выгрузили, а виджет остался со старой песней: честно показываем «ничего не играет», следующее нажатие откроет Linea
        if (!LineaPlugin.cmd(act)) show(c, null, null, false, null);
    }

    private static void draw(Context c, AppWidgetManager m) {
        int[] ids = m == null ? new int[0] : m.getAppWidgetIds(new ComponentName(c, LineaWidget.class));
        if (ids.length == 0) return;
        boolean on = title != null;
        // лаунчер применяет обновление поверх прошлого, поэтому задаём всё, даже то, что совпадает с разметкой
        RemoteViews v = new RemoteViews(c.getPackageName(), R.layout.linea_widget);
        v.setTextViewText(R.id.w_title, on ? title : "Linea");
        v.setTextViewText(R.id.w_artist, on ? artist : "Ничего не играет");
        if (on && art != null) v.setImageViewBitmap(R.id.w_art, art);
        else v.setImageViewResource(R.id.w_art, R.mipmap.ic_launcher);
        v.setImageViewResource(R.id.w_toggle, playing ? R.drawable.ic_w_pause : R.drawable.ic_w_play);
        v.setContentDescription(R.id.w_toggle, playing ? "Пауза" : "Играть");
        int fl = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        PendingIntent open = PendingIntent.getActivity(c, 0, new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), fl);
        v.setOnClickPendingIntent(R.id.w_root, open);
        for (int k = 0; k < BTNS.length; k++) {
            // пока ничего не играет, кнопкам нечем управлять — они просто открывают Linea
            v.setOnClickPendingIntent(BTNS[k], on ? PendingIntent.getBroadcast(c, k + 1, new Intent(c, LineaWidget.class).setAction(ACTS.get(k)), fl) : open);
        }
        m.updateAppWidget(ids, v);
    }
}
