package com.vegasdev.linea;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

// мост страница ↔ Android: ссылки из «Поделиться», кнопки уведомления, «Назад», музыка в фоне
@CapacitorPlugin(name = "Linea")
public class LineaPlugin extends Plugin {
    static LineaPlugin inst;

    @Override
    public void load() { inst = this; }

    static void share(String text) {
        if (inst == null) return;
        JSObject o = new JSObject();
        o.put("text", text);
        inst.notifyListeners("share", o, true); // страница может ещё грузиться — дождётся
    }

    // true, если страница слушает (тогда «Назад» обработает она)
    static boolean cmd(String c) {
        if (inst == null || !inst.hasListeners("cmd")) return false;
        JSObject o = new JSObject();
        o.put("cmd", c);
        inst.notifyListeners("cmd", o);
        return true;
    }

    @PluginMethod
    public void playing(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED && getActivity() != null) {
            ActivityCompat.requestPermissions(getActivity(), new String[] { Manifest.permission.POST_NOTIFICATIONS }, 7);
        }
        Intent i = new Intent(getContext(), PlayService.class);
        i.putExtra("title", call.getString("title", "Linea"));
        i.putExtra("artist", call.getString("artist", ""));
        i.putExtra("playing", Boolean.TRUE.equals(call.getBoolean("playing", false)));
        try {
            ContextCompat.startForegroundService(getContext(), i);
        } catch (Exception e) {
            // Android не даёт запускать службу из фона — уведомление обновится, когда вернёшься в Linea
        }
        call.resolve();
    }

    @PluginMethod
    public void minimize(PluginCall call) {
        if (getActivity() != null) getActivity().moveTaskToBack(true);
        call.resolve();
    }
}
