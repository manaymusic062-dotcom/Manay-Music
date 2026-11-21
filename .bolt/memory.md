# Project memory

## Product intent & audience

- Discord music bot menggunakan perintah awalan (`!play`, dll).
- PostgreSQL untuk menyimpan konfigurasi server; fitur pemutaran musik tidak butuh tulis DB.
- Backend audio: Lavalink.

## Brand personality & voice

- Bahasa Indonesia kasual dan ramah ("Aku", gaya percakapan).
- Langsung ke inti perbaikan; jelaskan akar masalah dan langkah yang diambil.

## Visual design & UX direction

- Antarmuka berbasis teks Discord; fokus pada kecepatan respons dan kejelasan pesan error.

## Decisions, constraints & rationale

- Konfigurasi server hanya dibaca sekali per perintah; pembacaan kedua dihapus karena menyebabkan `!play` menunggu lama lalu `DATABASE_ERROR`.
- Kegagalan koneksi PostgreSQL tidak boleh fatal untuk fitur musik.
- Waktu tunggu kegagalan koneksi harus singkat.
- `!play` tidak boleh menunggu koneksi voice selesai sebelum mencari dan memutar lagu; Lavalink menerima perintah putar dan mulai otomatis begitu koneksi siap.
- `waitForPlayerConnection` dihapus dari jalur play beserta fungsi/konstanta tak terpakai.

## Open questions & assumptions

- Token Discord bot saat ini tidak valid; bot belum bisa online untuk verifikasi langsung.
- Titik kegagalan pasti (koneksi PostgreSQL vs penyimpanan status musik) belum sepenuhnya dikonfirmasi.
- Format pesan error dan log lokal belum ditinjau mendalam.
- Detail konfigurasi/connection string PostgreSQL belum diketahui.