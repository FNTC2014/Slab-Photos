package com.fntc2014.slabplates;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Rect;
import android.net.Uri;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.mlkit.vision.barcode.BarcodeScanner;
import com.google.mlkit.vision.barcode.BarcodeScanning;
import com.google.mlkit.vision.barcode.common.Barcode;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.Text;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.latin.TextRecognizerOptions;

import java.io.OutputStream;

/**
 * On-device helpers for the Slab Plates page:
 *   readText     - ML Kit text recognition, returns lines with their boxes
 *   readBarcodes - ML Kit barcode scanning (cert barcodes on PCGS and NGC labels)
 *   saveImage    - writes a finished plate to Pictures/Slab Plates, no permission needed
 * Everything runs on the phone. Nothing is sent anywhere.
 */
@CapacitorPlugin(name = "SlabVision")
public class SlabVisionPlugin extends Plugin {

    private TextRecognizer recognizer;
    private BarcodeScanner scanner;

    @Override
    public void load() {
        recognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS);
        scanner = BarcodeScanning.getClient();
    }

    private static byte[] bytesOf(String data) {
        if (data == null) return null;
        int comma = data.indexOf(',');
        if (data.startsWith("data:") && comma > 0) data = data.substring(comma + 1);
        try {
            return Base64.decode(data, Base64.DEFAULT);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    private static Bitmap bitmapOf(String data) {
        byte[] b = bytesOf(data);
        return b == null ? null : BitmapFactory.decodeByteArray(b, 0, b.length);
    }

    private static void putBox(JSObject o, Rect r) {
        if (r == null) return;
        o.put("x", r.left);
        o.put("y", r.top);
        o.put("w", r.width());
        o.put("h", r.height());
    }

    @PluginMethod
    public void readText(PluginCall call) {
        Bitmap bmp = bitmapOf(call.getString("image"));
        if (bmp == null) {
            call.reject("Couldn't open that image for reading.");
            return;
        }
        final int width = bmp.getWidth(), height = bmp.getHeight();
        recognizer.process(InputImage.fromBitmap(bmp, 0))
            .addOnSuccessListener(text -> {
                JSArray lines = new JSArray();
                for (Text.TextBlock block : text.getTextBlocks()) {
                    for (Text.Line line : block.getLines()) {
                        JSObject o = new JSObject();
                        o.put("text", line.getText());
                        putBox(o, line.getBoundingBox());
                        lines.put(o);
                    }
                }
                JSObject ret = new JSObject();
                ret.put("lines", lines);
                ret.put("width", width);
                ret.put("height", height);
                call.resolve(ret);
            })
            .addOnFailureListener(e -> call.reject("Text reading failed: " + e.getMessage()));
    }

    @PluginMethod
    public void readBarcodes(PluginCall call) {
        Bitmap bmp = bitmapOf(call.getString("image"));
        if (bmp == null) {
            call.reject("Couldn't open that image for reading.");
            return;
        }
        scanner.process(InputImage.fromBitmap(bmp, 0))
            .addOnSuccessListener(codes -> {
                JSArray list = new JSArray();
                for (Barcode b : codes) {
                    JSObject o = new JSObject();
                    o.put("value", b.getRawValue());
                    o.put("format", b.getFormat());
                    putBox(o, b.getBoundingBox());
                    list.put(o);
                }
                JSObject ret = new JSObject();
                ret.put("barcodes", list);
                call.resolve(ret);
            })
            .addOnFailureListener(e -> call.reject("Barcode reading failed: " + e.getMessage()));
    }

    @PluginMethod
    public void saveImage(PluginCall call) {
        byte[] bytes = bytesOf(call.getString("data"));
        String name = call.getString("filename", "coin-plate.jpg");
        String folder = call.getString("folder", "Slab Plates");
        if (bytes == null || bytes.length == 0) {
            call.reject("There was no image to save.");
            return;
        }
        ContentResolver cr = getContext().getContentResolver();
        ContentValues values = new ContentValues();
        values.put(MediaStore.Images.Media.DISPLAY_NAME, name);
        values.put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg");
        values.put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/" + folder);
        values.put(MediaStore.Images.Media.IS_PENDING, 1);
        Uri uri = null;
        try {
            uri = cr.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
            if (uri == null) throw new Exception("The phone didn't give a place to save.");
            try (OutputStream out = cr.openOutputStream(uri)) {
                if (out == null) throw new Exception("Couldn't open the file for writing.");
                out.write(bytes);
            }
            ContentValues done = new ContentValues();
            done.put(MediaStore.Images.Media.IS_PENDING, 0);
            cr.update(uri, done, null, null);
            JSObject ret = new JSObject();
            ret.put("uri", uri.toString());
            ret.put("path", Environment.DIRECTORY_PICTURES + "/" + folder + "/" + name);
            call.resolve(ret);
        } catch (Exception e) {
            if (uri != null) cr.delete(uri, null, null);
            call.reject("Couldn't save the image: " + e.getMessage());
        }
    }
}
