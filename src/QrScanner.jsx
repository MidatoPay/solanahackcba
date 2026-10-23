import { useEffect, useRef, useState } from "react";
import jsQR from "jsqr";
import {nativeSecurityOperation} from './securitySession.js';

const MAX_SCAN_WIDTH = 720; // jsQR sobre frames reducidos: más rápido en celulares
const SCAN_INTERVAL_MS = 120;

/**
 * Escaneo de QR por cámara. Usa BarcodeDetector nativo si existe (Chrome Android) y jsQR como respaldo.
 * La cámara se abre una sola vez por montaje: los callbacks se leen por ref para no reiniciarla en cada render.
 * onCameraError recibe "insecure" | "unsupported" | "denied" | "unavailable".
 */
export default function QrScanner({ onDecode, onCameraError, onTorchSupport, fill = false, torchOn = false }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const callbacks = useRef({});
  callbacks.current = { onDecode, onCameraError, onTorchSupport };
  const [streamReady, setStreamReady] = useState(false);

  useEffect(() => {
    let cancelled = false, timer = null, detector = null;
    if (!navigator.mediaDevices?.getUserMedia) {
      callbacks.current.onCameraError?.(window.isSecureContext === false ? "insecure" : "unsupported");
      return undefined;
    }
    if ("BarcodeDetector" in window) {
      try { detector = new window.BarcodeDetector({ formats: ["qr_code"] }); } catch { detector = null; }
    }
    const readFrame = async (video) => {
      if (detector) {
        try {
          const codes = await detector.detect(video);
          return codes[0]?.rawValue || null;
        } catch {
          detector = null; // si el detector nativo falla, seguir con jsQR
        }
      }
      const canvas = canvasRef.current;
      const scale = Math.min(1, MAX_SCAN_WIDTH / video.videoWidth);
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
      return jsQR(frame.data, frame.width, frame.height)?.data || null;
    };
    const scan = async () => {
      if (cancelled) return;
      const video = videoRef.current;
      if (video && canvasRef.current && video.readyState >= video.HAVE_ENOUGH_DATA && video.videoWidth) {
        const data = await readFrame(video);
        if (cancelled) return;
        if (data) {
          navigator.vibrate?.(30);
          callbacks.current.onDecode?.(data);
          return;
        }
      }
      timer = setTimeout(scan, SCAN_INTERVAL_MS);
    };

    nativeSecurityOperation(()=>navigator.mediaDevices
      .getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false }),
      {onDiscard:stream=>stream.getTracks().forEach(track=>track.stop())})
      .then((stream) => {
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        setStreamReady(true);
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          video.play().catch(() => {});
        }
        scan();
      })
      .catch((error) => {
        if (!cancelled) callbacks.current.onCameraError?.(error?.name === "NotAllowedError" ? "denied" : "unavailable");
      });

    return () => {
      cancelled = true;
      clearTimeout(timer);
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setStreamReady(false);
    };
  }, []);

  useEffect(() => {
    if (!streamReady) return;
    const track = streamRef.current?.getVideoTracks?.()[0];
    callbacks.current.onTorchSupport?.(Boolean(track?.getCapabilities?.().torch));
  }, [streamReady]);

  useEffect(() => {
    if (!streamReady) return;
    const track = streamRef.current?.getVideoTracks?.()[0];
    if (!track) return;
    track.applyConstraints({ advanced: [{ torch: torchOn }] }).catch(() => {});
  }, [torchOn, streamReady]);

  return (
    <div
      style={
        fill
          ? { position: "absolute", inset: 0, background: "#000", overflow: "hidden" }
          : { position: "relative", borderRadius: 16, overflow: "hidden", background: "#000" }
      }
    >
      <video
        ref={videoRef}
        muted
        playsInline
        autoPlay
        style={fill ? { width: "100%", height: "100%", objectFit: "cover", display: "block" } : { width: "100%", display: "block" }}
      />
      <canvas ref={canvasRef} style={{ display: "none" }} />
    </div>
  );
}
