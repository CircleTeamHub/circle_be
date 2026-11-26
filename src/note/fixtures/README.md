# HEIC regression fixture

`rainbow-451x461.heic` is the small generated rainbow test image from
[libheif](https://github.com/strukturag/libheif/blob/master/tests/data/rainbow-451x461.heic).
Upstream Git blob: `6691f50f39bd69871a2abe284de2ef9f5243bc66`.
The upstream license notice is preserved in `libheif-COPYING`.

The renderer test decodes this actual HEVC-compressed file with the same prebuilt
Sharp dependencies used in the deployed image. It must run without system HEVC plugins.
