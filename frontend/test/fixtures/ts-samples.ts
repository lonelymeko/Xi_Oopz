/**
 * 极小的真实 MPEG-TS 样本（base64 内嵌，避免把二进制塞进仓库）。
 *
 * 生成方式（ffmpeg 8.0.1）：
 *   ffmpeg -f lavfi -i "testsrc=size=64x48:rate=5:duration=0.4" -c:v libx264 -pix_fmt yuv420p -f mpegts h264.ts
 *   ffmpeg -f lavfi -i "testsrc=size=64x48:rate=5:duration=0.4" -c:v libx265 -pix_fmt yuv420p \
 *     -x265-params log-level=none -f mpegts hevc.ts
 * ffprobe 已确认两者视频编码分别是 h264 / hevc，大小 2632 / 4324 字节。
 *
 * 用途：验证 TS→fMP4 转封装的编码闸门——H.264 能转，HEVC 必须被拦下回退 .ts。
 *
 * 注意：base64 必须用显式 `+` 串联。JS 没有隐式字符串拼接，写成相邻字符串字面量会被
 * 自动分号插入拆成「第一行赋值 + 若干无用表达式」，静默只解码第一行。
 */
const H264_TS_BASE64 =
  "R0AREABC8CUAAcEAAP8B/wAB/IAUSBIBBkZGbXBlZwlTZXJ2aWNlMDF3fEPK//////////////////////////////////////////////////" +
  "//////////////////////////////////////////////////////////////////////////////////////////////////////////////" +
  "//////////////////////////////9HQAAQAACwDQABwQAAAAHwACqxBLL///////////////////////////////////////////////////" +
  "//////////////////////////////////////////////////////////////////////////////////////////////////////////////" +
  "/////////////////////////////////////////////////////////////0dQABAAArASAAHBAADhAPAAG+EA8AAVvU1W//////////////" +
  "//////////////////////////////////////////////////////////////////////////////////////////////////////////////" +
  "////////////////////////////////////////////////////////////////////////////////////////////R0EAMAdQAAB7DH4AAA" +
  "AB4AAAgIAFIQAH2GEAAAABCfAAAAABZ2QACqzZRHsBEAAAAwAQAAADAKDxIllgAAAAAWjr48siwAAAAQYF//+p3EXpvebZSLeWLNgg2SPu73gy" +
  "NjQgLSBjb3JlIDE2NSByMzIyMiBiMzU2MDVhIC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAyNSAtIGh0dHA6Ly" +
  "93d3cudmlkZW9HAQARbGFuLm9yZy94MjY0Lmh0bWwgLSBvcHRpb25zOiBjYWJhYz0xIHJlZj0zIGRlYmxvY2s9MTowOjAgYW5hbHlzZT0weDM6" +
  "MHgxMTMgbWU9aGV4IHN1Ym1lPTcgcHN5PTEgcHN5X3JkPTEuMDA6MC4wMCBtaXhlZF9yZWY9MSBtZV9yYW5nZT0xNiBjaHJvbWFfbWU9MSB0cm" +
  "VsbGlzPTEgOHg4ZGN0PTEgY3FtPTAgZGVhZHpvbmU9MkcBABIxLDExIGZhc3RfcHNraXA9MSBjaHJvbWFfcXBfb2Zmc2V0PS0yIHRocmVhZHM9" +
  "MSBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9MCBibHVyYXlfY29tcGF0PT" +
  "AgY29uc3RyYWluZWRfaW50cmE9MCBiZnJhbWVzPTMgYl9weXJhbWlkPTIgYl9hZGFwdD0xIGJfRwEAE2JpYXM9MCBkaXJlY3Q9MSB3ZWlnaHRi" +
  "PTEgb3Blbl9nb3A9MCB3ZWlnaHRwPTIga2V5aW50PTI1MCBrZXlpbnRfbWluPTUgc2NlbmVjdXQ9NDAgaW50cmFfcmVmcmVzaD0wIHJjX2xvb2" +
  "thaGVhZD00MCByYz1jcmYgbWJ0cmVlPTEgY3JmPTIzLjAgcWNvbXA9MC42MCBxcG1pbj0wIHFwbWF4PTY5IHFwc3RlcD00IGlwX3JhdGlHAQAU" +
  "bz0xLjQwIGFxPTE6MS4wMACAAAABZYiEAEfkcSgz0m//hGwDWa9xRs1aSuODogHWQ9l5E518vKCfG8qKc3JDuIFzUOUkELIv3qkhxN32J+R+E8" +
  "XTLd5J7H3eU2kiQbKVZ9my2KN8P/dilAIx5CD+JoSloEhNCkvwFlyoQ3SfiDCV03jlkyweLlwrwGb44UxFF2XQt79OVNDuzbQgrQGGWKZNOKN/" +
  "XyW8+1dM0bz9RRh9O7kJGmpgwkcBABVsmcQvhVJX7Vo6zY8tnsTRva7dBpAHAwR3/t63LwpddUyRKGnO2H5uzMjd6LNSR6gIZ3a8H7GaalPudI" +
  "Gb7SX+9rHgYN2IoS5U7UfSmiiig1b3hWBEUZ+X8Lop/1ILEymqQAziTSH/Q4pEFdfQ2LnRW6fAXkFp+T302IhwWX1CR0lXhIZs/Evp6mylSsB6" +
  "kfG1asXdFKujjDFNuad8oz5tGAipWWcThXVswQM2taZk6fT8wbsdJMgXRwEAFnCRPSbVF0chPGt2d8nL+1j2nETiggAm1RTvzCvI5CteLgX7X2" +
  "Co70F+rGp7GbtkfJ+wuok4zApLEh7eXzlQobFdBz5msxhzz2lAVvpY03PYRreBIMCPq0teLXFy3e301ET3ExYlm8TgjyYviQP04sVcZY3HrEVR" +
  "ibkcK2PxEbWSmBN1XIS9V6dvWG83O164mO0441A1KN+XAVAr1noQ7BvC9jSy4rAu5TDzVqVmGZTD3i3PcRQ0UpNHAQA3ZQD///////////////" +
  "//////////////////////////////////////////////////////////////////////////////////////////////////////////////" +
  "////////fepTVRJ0JdeJ0YBcL0mGKLrI0kP+BOrG3l/ycFtdRGz0pI2G1F6MLYLbwqsBSWmDKCoTpJL7SkhmNyUUH9pOB+YDEieQvgQYSLUUOb" +
  "sc1Mjn4UdAABEAALANAAHBAAAAAfAAKrEEsv//////////////////////////////////////////////////////////////////////////" +
  "//////////////////////////////////////////////////////////////////////////////////////////////////////////////" +
  "//////////////////////////////////////R1AAEQACsBIAAcEAAOEA8AAb4QDwABW9TVb/////////////////////////////////////" +
  "//////////////////////////////////////////////////////////////////////////////////////////////////////////////" +
  "////////////////////////////////////////////////////////////////////9HQQA4NBAAAJ40fgD/////////////////////////" +
  "//////////////////////////////////8AAAHgAACAgAUhAAllAQAAAAEJ8AAAAAFBmiFsRn8VCd3eU/188f2W4CKVnj9kzzdteA9q5II0oy" +
  "gwszBhA8DDfMh2SBUNE0UIUIkeej4EBVtgVM+tdXKcCIRZ+lZEGk5sGkXP1pOedro+8XQn39GISOZ+Z/lC8BJZYNllG3xUov5rwA==";

const HEVC_TS_BASE64 =
  "R0AREABC8CUAAcEAAP8B/wAB/IAUSBIBBkZGbXBlZwlTZXJ2aWNlMDF3fEPK//////////////////////////////////////////////////" +
  "//////////////////////////////////////////////////////////////////////////////////////////////////////////////" +
  "//////////////////////////////9HQAAQAACwDQABwQAAAAHwACqxBLL///////////////////////////////////////////////////" +
  "//////////////////////////////////////////////////////////////////////////////////////////////////////////////" +
  "/////////////////////////////////////////////////////////////0dQABAAArAYAAHBAADhAPAAJOEA8AYFBEhFVkPLngBS//////" +
  "//////////////////////////////////////////////////////////////////////////////////////////////////////////////" +
  "////////////////////////////////////////////////////////////////////////////////////////////R0EAMAdQAAB7DH4AAA" +
  "AB4AAAgIAFIQAH2GEAAAABRgFQAAAAAUABDAH//wFgAAADAJAAAAMAAAMAHpWYCQAAAAFCAQEBYAAAAwCQAAADAAADAB6gIIMWWVmuTK8BaAgA" +
  "AAMACAAAAwAoQAAAAAFEAcFz0IkAAAFOAQX///////////8DLKLeCbUXR9u7VaT+f8L8TngyNjUgKGJ1aWxkIDIxNSkgLSA0LjErMS0xZDExN2" +
  "JlOltNYWMgT1NHAQARIFhdW2NsYW5nIDE3LjAuMF1bNjQgYml0XSA4Yml0KzEwYml0KzEyYml0IC0gSC4yNjUvSEVWQyBjb2RlYyAtIENvcHly" +
  "aWdodCAyMDEzLTIwMTggKGMpIE11bHRpY29yZXdhcmUsIEluYyAtIGh0dHA6Ly94MjY1Lm9yZyAtIG9wdGlvbnM6IGNwdWlkPTk4IGZyYW1lLX" +
  "RocmVhZHM9MSBuby13cHAgbm8tcG1vZGUgbm8tcG1lIEcBABJuby1wc25yIG5vLXNzaW0gbG9nLWxldmVsPS0xIGJpdGRlcHRoPTggaW5wdXQt" +
  "Y3NwPTEgZnBzPTUvMSBpbnB1dC1yZXM9NjR4NDggaW50ZXJsYWNlPTAgdG90YWwtZnJhbWVzPTAgbGV2ZWwtaWRjPTAgaGlnaC10aWVyPTEgdW" +
  "hkLWJkPTAgcmVmPTMgbm8tYWxsb3ctbm9uLWNvbmZvcm1hbmNlIHJlcGVhdC1oZWFkZXJzIGFuRwEAE25leGIgbm8tYXVkIG5vLWVvYiBuby1l" +
  "b3Mgbm8taHJkIGluZm8gaGFzaD0wIHRlbXBvcmFsLWxheWVycz0wIG9wZW4tZ29wIG1pbi1rZXlpbnQ9NSBrZXlpbnQ9MjUwIGdvcC1sb29rYW" +
  "hlYWQ9MCBiZnJhbWVzPTQgYi1hZGFwdD0yIGItcHlyYW1pZCBiZnJhbWUtYmlhcz0wIHJjLWxvb2thaGVhZD0yMCBsb29rYWhlYWQtc2xHAQAU" +
  "aWNlcz0wIHNjZW5lY3V0PTQwIG5vLWhpc3Qtc2NlbmVjdXQgcmFkbD0wIG5vLXNwbGljZSBuby1pbnRyYS1yZWZyZXNoIGN0dT0zMiBtaW4tY3" +
  "Utc2l6ZT04IG5vLXJlY3Qgbm8tYW1wIG1heC10dS1zaXplPTMyIHR1LWludGVyLWRlcHRoPTEgdHUtaW50cmEtZGVwdGg9MSBsaW1pdC10dT0w" +
  "IHJkb3EtbGV2ZWw9MCBkeW5hbUcBABVpYy1yZD0wLjAwIG5vLXNzaW0tcmQgc2lnbmhpZGUgbm8tdHNraXAgbnItaW50cmE9MCBuci1pbnRlcj" +
  "0wIG5vLWNvbnN0cmFpbmVkLWludHJhIHN0cm9uZy1pbnRyYS1zbW9vdGhpbmcgbWF4LW1lcmdlPTMgbGltaXQtcmVmcz0xIG5vLWxpbWl0LW1v" +
  "ZGVzIG1lPTEgc3VibWU9MiBtZXJhbmdlPTU3IHRlbXBvcmFsLW12cCBuRwEAFm8tZnJhbWUtZHVwIG5vLWhtZSB3ZWlnaHRwIG5vLXdlaWdodG" +
  "Igbm8tYW5hbHl6ZS1zcmMtcGljcyBkZWJsb2NrPTA6MCBzYW8gbm8tc2FvLW5vbi1kZWJsb2NrIHJkPTMgc2VsZWN0aXZlLXNhbz00IGVhcmx5" +
  "LXNraXAgcnNraXAgbm8tZmFzdC1pbnRyYSBuby10c2tpcC1mYXN0IG5vLWN1LWxvc3NsZXNzIGItaW50cmEgbm9HAQAXLXNwbGl0cmQtc2tpcC" +
  "ByZHBlbmFsdHk9MCBwc3ktcmQ9Mi4wMCBwc3ktcmRvcT0wLjAwIG5vLXJkLXJlZmluZSBuby1sb3NzbGVzcyBjYnFwb2Zmcz0wIGNycXBvZmZz" +
  "PTAgcmM9Y3JmIGNyZj0yOC4wIHFjb21wPTAuNjAgcXBzdGVwPTQgc3RhdHMtd3JpdGU9MCBzdGF0cy1yZWFkPTAgaXByYXRpbz0xLjQwIHBicm" +
  "F0aW89MUcBABguMzAgYXEtbW9kZT0yIGFxLXN0cmVuZ3RoPTEuMDAgY3V0cmVlIHpvbmUtY291bnQ9MCBuby1zdHJpY3QtY2JyIHFnLXNpemU9" +
  "MzIgbm8tcmMtZ3JhaW4gcXBtYXg9NjkgcXBtaW49MCBuby1jb25zdC12YnYgc2FyPTEgb3ZlcnNjYW49MCB2aWRlb2Zvcm1hdD01IHJhbmdlPT" +
  "AgY29sb3JwcmltPTIgdHJhbnNmZXI9MiBjb2xvRwEAGXJtYXRyaXg9MiBjaHJvbWFsb2M9MCBkaXNwbGF5LXdpbmRvdz0wIGNsbD0wLDAgbWlu" +
  "LWx1bWE9MCBtYXgtbHVtYT0yNTUgbG9nMi1tYXgtcG9jLWxzYj04IHZ1aS10aW1pbmctaW5mbyB2dWktaHJkLWluZm8gc2xpY2VzPTEgbm8tb3" +
  "B0LXFwLXBwcyBuby1vcHQtcmVmLWxpc3QtbGVuZ3RoLXBwcyBuby1tdWx0aS1wYXNzLW9HAQAacHQtcnBzIHNjZW5lY3V0LWJpYXM9MC4wNSBu" +
  "by1vcHQtY3UtZGVsdGEtcXAgbm8tYXEtbW90aW9uIG5vLWhkcjEwIG5vLWhkcjEwLW9wdCBuby1kaGRyMTAtb3B0IG5vLWlkci1yZWNvdmVyeS" +
  "1zZWkgYW5hbHlzaXMtcmV1c2UtbGV2ZWw9MCBhbmFseXNpcy1zYXZlLXJldXNlLWxldmVsPTAgYW5hbHlzaXMtbG9hZC1yZXVzZUcBABstbGV2" +
  "ZWw9MCBzY2FsZS1mYWN0b3I9MCByZWZpbmUtaW50cmE9MCByZWZpbmUtaW50ZXI9MCByZWZpbmUtbXY9MSByZWZpbmUtY3R1LWRpc3RvcnRpb2" +
  "49MCBuby1saW1pdC1zYW8gY3R1LWluZm89MCBuby1sb3dwYXNzLWRjdCByZWZpbmUtYW5hbHlzaXMtdHlwZT0wIGNvcHktcGljPTEgbWF4LWF1" +
  "c2l6ZS1mYWN0b3I9MS4wRwEAHCBuby1keW5hbWljLXJlZmluZSBuby1zaW5nbGUtc2VpIG5vLWhldmMtYXEgbm8tc3Z0IG5vLWZpZWxkIHFwLW" +
  "FkYXB0YXRpb24tcmFuZ2U9MS4wMCBzY2VuZWN1dC1hd2FyZS1xcD0wY29uZm9ybWFuY2Utd2luZG93LW9mZnNldHMgcmlnaHQ9MCBib3R0b209" +
  "MCBkZWNvZGVyLW1heC1yYXRlPTAgbm8tdmJ2LWxpdmUtbXVsdGlHAQAdLXBhc3Mgbm8tbWNzdGYgbm8tc2JyYyBuby1mcmFtZS1yY4AAAAEoAa" +
  "8mtAeWHz/4O7RZoe0g80vVCSK0N9YAcy3/nDmpRP/t6iMiGBgiQ083wGsdzABJXKSG8rsvjHlGZpP3v+0m////11lEBblurKYAAtAib//egX/B" +
  "+DizU/vev/LtEurP1nJDQ/HvvlpNLPqvGJ7sVqH+1aJ0CXcIIwlCX4RibIWAXGC/4vfS2354UrMYg1xwgUcBAB7QHcbj14H18boconmwEMrS6S" +
  "Olxh9QZ5w6PzoWfsFKYVGW0gpLCc+k/zU8WWHva97nnnLVopvBbS3XXBIXGWHY3vBDLboTvL57cqxFeEVv3lX1aoPPGZ74/nONh9zsu+6vvHCa" +
  "BukRLWqFypCl6ZmB7mnRIJmudJK7ORSrJX399GXbODiuzFgSsCc2kD0TQ8oRIqYDOYc4Ny8bCnKHEF+D16rfUcNfvnPMth1uinyDr3gDsS81Wo" +
  "VjRwEAHzhnwg0YwTy2szlzw8GJpbmA7whe44RRqezb3HzoFfa4kLMKHZnQxYclBF8bRRTXBAXMqqpDmN6H8mzIJjuD7PqVTujFII75M+CbQTSC" +
  "2bgxv8kd4ZdVV/W6p4oYfX5rfWtI85zgkZNzopjQsBEH6XjLpMAAWxYObcTwirx9Iaukg0m8arZsssqXWt/QEko5fDO0LNkshXzTCcwUMh4Cdq" +
  "3chMSUCcY7fklIiqdFgy3t/G5ftSBjeGZHAQAwsgD/////////////////////////////////////////////////////////////////////" +
  "//////////////////////////////////////////////////////////////////////////////////////////////////////////////" +
  "////////////////////////////////////////////////////////8h36PhgEdAABEAALANAAHBAAAAAfAAKrEEsv//////////////////" +
  "//////////////////////////////////////////////////////////////////////////////////////////////////////////////" +
  "//////////////////////////////////////////////////////////////////////////////////////////////R1AAEQACsBgAAcEA" +
  "AOEA8AAk4QDwBgUESEVWQ8ueAFL///////////////////////////////////////////////////////////////////////////////////" +
  "//////////////////////////////////////////////////////////////////////////////////////////////////////////////" +
  "//////////////9HQQAxQRAAAJ40fgD/////////////////////////////////////////////////////////////////////////////AA" +
  "AB4AAAgIAFIQAJZQEAAAABRgFQAAAAAQIB0Al+EMZMWe73kXQX1VoOqM7uEz//KQS4JhMD/mzhj+8YIKcHmZ7HrPjn3LMm86gJz90th7ASfv+g" +
  "RQyoq/h9h26Xp93vH+lkQODnJCR1aqRiOoiZbRI/zDLkuA==";

/** base64 → 字节。atob 在浏览器与 jsdom 下都可用。 */
export function decodeBase64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** 与生成时一致：2632 字节。样例自检，防止 base64 被截断（见上面 ASI 的坑）。 */
export const H264_TS_BYTE_LENGTH = 2632;
export const HEVC_TS_BYTE_LENGTH = 4324;

export const h264TsBytes = () => decodeBase64ToBytes(H264_TS_BASE64);
export const hevcTsBytes = () => decodeBase64ToBytes(HEVC_TS_BASE64);
