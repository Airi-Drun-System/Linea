package com.vegasdev.linea;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.OutputStream;

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
        i.putExtra("pos", call.getDouble("pos", 0.0).longValue());
        i.putExtra("dur", call.getDouble("dur", 0.0).longValue());
        i.putExtra("art", call.getString("art", ""));
        try {
            ContextCompat.startForegroundService(getContext(), i);
        } catch (Exception e) {
            // Android не даёт запускать службу из фона — уведомление обновится, когда вернёшься в Linea
        }
        call.resolve();
    }

    // «Перенос»: куда сохранить файл, спрашивает сам Android — разрешения на память не нужны
    private OutputStream out;

    @PluginMethod
    public void saveOpen(PluginCall call) {
        Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("application/octet-stream");
        i.putExtra(Intent.EXTRA_TITLE, call.getString("name", "Linea.linea"));
        startActivityForResult(call, i, "saveOpened");
    }

    @ActivityCallback
    private void saveOpened(PluginCall call, ActivityResult r) {
        if (call == null) return;
        Uri uri = r.getResultCode() == Activity.RESULT_OK && r.getData() != null ? r.getData().getData() : null;
        try {
            out = uri == null ? null : getContext().getContentResolver().openOutputStream(uri);
        } catch (Exception e) {
            out = null;
        }
        JSObject o = new JSObject();
        o.put("ok", out != null);
        call.resolve(o);
    }

    // файл приходит кусками в base64: целиком через мост большой не пролез бы
    @PluginMethod
    public void saveWrite(PluginCall call) {
        try {
            out.write(Base64.decode(call.getString("b64", ""), Base64.DEFAULT));
            call.resolve();
        } catch (Exception e) {
            call.reject("Не записалось");
        }
    }

    @PluginMethod
    public void saveClose(PluginCall call) {
        try {
            if (out != null) out.close();
            call.resolve();
        } catch (Exception e) {
            call.reject("Не записалось");
        } finally {
            out = null;
        }
    }

    @PluginMethod
    public void minimize(PluginCall call) {
        if (getActivity() != null) getActivity().moveTaskToBack(true);
        call.resolve();
    }
}
