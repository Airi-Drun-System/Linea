package com.vegasdev.linea;

import android.content.Intent;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

// окно Linea: принимает ссылки из «Поделиться» и отдаёт «Назад» странице (она сама решит: закрыть окно или свернуться)
public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(LineaPlugin.class);
        super.onCreate(savedInstanceState);
        handle(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handle(intent);
    }

    private void handle(Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) return;
        String text = intent.getStringExtra(Intent.EXTRA_TEXT);
        if (text != null) LineaPlugin.share(text);
    }

    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() {
        if (!LineaPlugin.cmd("back")) super.onBackPressed();
    }
}
