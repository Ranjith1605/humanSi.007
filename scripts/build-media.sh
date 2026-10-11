#!/usr/bin/env bash
# Regenerates every briefing-room image and video from the one original
# illustration, web/assets/img/crew-briefing-original.jpg (896x1200 portrait:
# the crew in the ship's briefing room, the captain under the skylight with a
# holographic halo, holding the ship's penguin navigator, the crew around the
# table). The original is only read, never modified.
#
# Outputs (the "Media" table in docs/ARCHITECTURE.md):
#
#   web/assets/img/crew-briefing.webp, .jpg          896x1200  the full image, web-optimised
#   web/assets/img/briefing-poster-16x9.webp, .jpg   1280x720  frame 0 of briefing-16x9
#   web/assets/img/briefing-poster-9x16.webp, .jpg   720x1280  frame 0 of briefing-9x16
#   web/assets/video/briefing-16x9.webm (VP9), .mp4 (H.264)
#                                                    1280x720, 30 fps, 14 s seamless loop, no audio:
#                                                    a 16:9 window travelling down the portrait image
#                                                    from the skylight past the captain and penguin to
#                                                    the table, then easing back up (a ping-pong move,
#                                                    so the loop point is a still moment, not a cut)
#   web/assets/video/briefing-9x16.webm, .mp4        720x1280 portrait version: nearly the full width,
#                                                    the same descent as a slow push-in
#   web/assets/img/comms-captain.webp                256x256   the captain's face with the visor
#   web/assets/img/comms-navigator.webp              256x256   the penguin's head and chest
#
# Both videos also carry a breathing glow on the skylight light, a slow shimmer
# on the halo, dust motes in the light shafts, fine film grain and a vignette.
# The posters are the exact first frame of their video, so the swap from poster
# to playing video does not shift or change the picture.
#
# Encoding: JPG progressive q82, WebP q78 (comms portraits q80, they are tiny);
# VP9 two-pass constant quality (crf 37, -b:v 0, row-mt); H.264 High profile,
# crf 27, preset slow, yuv420p, +faststart. Colour is converted to BT.709
# limited range and tagged as such, which is how browsers decode HD video, so
# the video matches its sRGB poster. Each video must stay at or under 3 MiB;
# the script fails if one does not.
#
# How the frames are made: scripts/media/briefing.py renders every frame with
# Pillow + NumPy (sub-pixel camera, light layers, grain) into a lossless FFV1
# master, and ffmpeg encodes the deliverables from that master. See that file
# for why the camera is not an ffmpeg crop expression.
#
# Usage:   scripts/build-media.sh          (from any directory; it works in the repo root)
# Needs:   bash, ffmpeg + ffprobe with libvpx-vp9, libx264 and ffv1;
#          python3 with Pillow and NumPy (Debian/Ubuntu: python3-pil python3-numpy).
# Time:    a few minutes on a 4-core laptop. Temporary files (~1 GB) go to
#          ${TMPDIR:-/tmp} and are removed on exit, success or failure.
#
# Idempotent: the render is deterministic (fixed seeds), encoder thread counts
# are pinned and the muxers run bitexact with metadata stripped, so running it
# again rewrites byte-identical files and leaves git with nothing to commit.
# Every output is written to the temp directory first and moved into place
# only when it is complete, so a failed run never leaves a half-written asset.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

SRC=web/assets/img/crew-briefing-original.jpg
IMG=web/assets/img
VID=web/assets/video
PY=scripts/media/briefing.py

VP9_CRF=37
X264_CRF=27
THREADS=4                         # pinned: encoder output depends on the thread count
MAX_VIDEO_BYTES=$((3 * 1024 * 1024))

die() { echo "build-media: $*" >&2; exit 1; }

command -v ffmpeg >/dev/null 2>&1 || die "ffmpeg is required"
command -v ffprobe >/dev/null 2>&1 || die "ffprobe is required"
command -v python3 >/dev/null 2>&1 || die "python3 is required"
python3 -c 'import PIL, numpy' 2>/dev/null \
  || die "python3 needs Pillow and NumPy (Debian/Ubuntu: apt install python3-pil python3-numpy)"
encoders="$(ffmpeg -hide_banner -encoders 2>/dev/null)"
for enc in libvpx-vp9 libx264 ffv1; do
  grep -q " $enc " <<<"$encoders" || die "this ffmpeg has no $enc encoder"
done
[ -f "$SRC" ] || die "missing source image $SRC"
mkdir -p "$IMG" "$VID"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/build-media.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

FF=(ffmpeg -hide_banner -loglevel error -nostdin -y)
# RGB -> BT.709 limited-range 4:2:0 with full-precision chroma, and tags that say so.
TO_YUV="scale=out_color_matrix=bt709:out_range=tv:flags=lanczos+accurate_rnd+full_chroma_int,format=yuv420p"
COLOR_TAGS=(-colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv)
# No muxer version strings, dates or random IDs in the files: that is what makes reruns byte-identical.
CLEAN=(-map_metadata -1 -fflags +bitexact -an)

publish() { # publish TEMPFILE DEST: move a finished file into place
  mv -f "$1" "$2"
  printf '  %-42s %9s bytes\n' "$2" "$(stat -c %s "$2")"
}

echo "stills"
python3 "$PY" stills "$SRC" "$TMP"
for f in crew-briefing.jpg crew-briefing.webp comms-captain.webp comms-navigator.webp; do
  publish "$TMP/$f" "$IMG/$f"
done

for shape in 16x9 9x16; do
  read -r width height fps frames tiles < <(python3 "$PY" info "$shape")
  master="$TMP/master-$shape.nut"   # NUT keeps an exact 1/30 s timebase (Matroska would round to ms)

  echo "briefing $shape: rendering $frames frames at ${width}x${height}, $fps fps"
  python3 "$PY" frames "$SRC" "$shape" "$TMP/poster-$shape.png" \
    | "${FF[@]}" -f rawvideo -pix_fmt rgb24 -s "${width}x${height}" -r "$fps" -i - \
        -c:v ffv1 -level 3 -g 1 "$master"

  python3 "$PY" poster "$TMP/poster-$shape.png" "$TMP" "$shape"
  publish "$TMP/briefing-poster-$shape.jpg" "$IMG/briefing-poster-$shape.jpg"
  publish "$TMP/briefing-poster-$shape.webp" "$IMG/briefing-poster-$shape.webp"

  echo "briefing $shape: VP9 (two-pass)"
  vp9=(-c:v libvpx-vp9 -crf "$VP9_CRF" -b:v 0 -row-mt 1 -tile-columns "$tiles" -threads "$THREADS"
       -g 150 -auto-alt-ref 1 -lag-in-frames 25 -pix_fmt yuv420p)
  "${FF[@]}" -i "$master" -vf "$TO_YUV" "${vp9[@]}" -deadline good -cpu-used 4 \
    -pass 1 -passlogfile "$TMP/vp9-$shape" -an -f null /dev/null
  "${FF[@]}" -i "$master" -vf "$TO_YUV" "${vp9[@]}" -deadline good -cpu-used 1 \
    -pass 2 -passlogfile "$TMP/vp9-$shape" "${COLOR_TAGS[@]}" "${CLEAN[@]}" "$TMP/briefing-$shape.webm"
  publish "$TMP/briefing-$shape.webm" "$VID/briefing-$shape.webm"

  echo "briefing $shape: H.264"
  "${FF[@]}" -i "$master" -vf "$TO_YUV" -c:v libx264 -preset slow -crf "$X264_CRF" \
    -profile:v high -level:v 4.0 -pix_fmt yuv420p -threads "$THREADS" -g 150 \
    "${COLOR_TAGS[@]}" "${CLEAN[@]}" -movflags +faststart "$TMP/briefing-$shape.mp4"
  publish "$TMP/briefing-$shape.mp4" "$VID/briefing-$shape.mp4"

  rm -f "$master" "$TMP/poster-$shape.png" "$TMP"/vp9-"$shape"*
done

echo "checks"
fail=0
for f in "$VID"/briefing-16x9.webm "$VID"/briefing-16x9.mp4 "$VID"/briefing-9x16.webm "$VID"/briefing-9x16.mp4; do
  bytes=$(stat -c %s "$f")
  info=$(ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,width,height,r_frame_rate \
           -show_entries format=duration -of default=nw=1:nk=1 "$f" | paste -sd' ')
  audio=$(ffprobe -v error -select_streams a -show_entries stream=index -of csv=p=0 "$f")
  printf '  %-34s %s  %9s bytes\n' "$f" "$info" "$bytes"
  [ -z "$audio" ] || { echo "  ^ has an audio track" >&2; fail=1; }
  [ "$bytes" -le "$MAX_VIDEO_BYTES" ] || { echo "  ^ over the 3 MiB budget" >&2; fail=1; }
done
[ "$fail" -eq 0 ] || die "video checks failed"
echo "done"
