# Project memory

## Product intent & audience

- Discord music bot menggunakan perintah awalan (`!play`, dll).
- Menggunakan PostgreSQL untuk menyimpan konfigurasi server.
- Fitur pemutaran musik tidak memerlukan penulisan ke database.

## Brand personality & voice

- Bahasa Indonesia kasual dan ramah ("Aku", gaya percakapan).
- Langsung ke inti perbaikan; jelaskan akar masalah dan langkah yang diambil.

## Visual design & UX direction

- Antarmuka berbasis teks Discord; fokus pada kecepatan respons dan kejelasan pesan error.

## Decisions, constraints & rationale

- Konfigurasi server hanya dibaca sekali per perintah awalan; pembacaan kedua dihapus karena menyebabkan `!play` menunggu lama lalu menampilkan `DATABASE_ERROR`.
- Kegagalan koneksi PostgreSQL tidak boleh diperlakukan sebagai error fatal untuk fitur musik yang tidak butuh database.
- Waktu tunggu kegagalan koneksi harus singkat agar bot tetap responsif.

## Open questions & assumptions

- Titik kegagalan pasti belum sepenuhnya dikonfirmasi: koneksi PostgreSQL vs penyimpanan status musik.
- Format pesan error dan log lokal belum ditinjau secara mendalam.
- Detail konfigurasi/connection string PostgreSQL belum diketahui.