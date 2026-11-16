package com.psyrob.suite.app

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.unit.dp

/** PSYROB marks (psyrob-icon-font-pack, plus app marks drawn in the same style): 64 grid, square caps, faint fill, tinted by LocalContentColor. Generated from icons.js. */
object PsyIcons {
    private class P(val d: String, val fill: Boolean, val fillAlpha: Float, val stroke: Boolean, val strokeAlpha: Float, val width: Float)
    private val cache = HashMap<String, ImageVector>()
    private val defs: Map<String, List<P>> = mapOf(
        "wallet" to listOf(P("M10.0,18.0h44.0v30.0h-44.0z", true, 0.06f, true, 1.0f, 2.0f), P("M32.0,28.0h22.0v12.0h-22.0z", true, 0.12f, true, 1.0f, 2.0f), P("M44.0,34.0a2.0,2.0 0 1,0 4.0,0a2.0,2.0 0 1,0 -4.0,0z", true, 1.0f, false, 1.0f, 2.0f)),
        "settings" to listOf(P("M24.0,32.0a8.0,8.0 0 1,0 16.0,0a8.0,8.0 0 1,0 -16.0,0z", false, 1.0f, true, 1.0f, 2.0f), P("M29.0,32.0a3.0,3.0 0 1,0 6.0,0a3.0,3.0 0 1,0 -6.0,0z", true, 1.0f, false, 1.0f, 2.0f), P("M32 12 L32 18", false, 1.0f, true, 1.0f, 2.0f), P("M32 46 L32 52", false, 1.0f, true, 1.0f, 2.0f), P("M12 32 H18", false, 1.0f, true, 1.0f, 2.0f), P("M46 32 H52", false, 1.0f, true, 1.0f, 2.0f), P("M18 18 L22 22", false, 1.0f, true, 1.0f, 2.0f), P("M42 42 L46 46", false, 1.0f, true, 1.0f, 2.0f), P("M18 46 L22 42", false, 1.0f, true, 1.0f, 2.0f), P("M42 22 L46 18", false, 1.0f, true, 1.0f, 2.0f)),
        "globe" to listOf(P("M12.0,32.0a20.0,20.0 0 1,0 40.0,0a20.0,20.0 0 1,0 -40.0,0z", false, 1.0f, true, 1.0f, 2.0f), P("M12 32 H52", false, 1.0f, true, 1.0f, 1.6f), P("M32 12 C26 20 26 44 32 52", false, 1.0f, true, 1.0f, 1.6f), P("M32 12 C38 20 38 44 32 52", false, 1.0f, true, 1.0f, 1.6f)),
        "shield" to listOf(P("M32,8 L50,16 L48,34 L32,56 L16,34 L14,16 Z", true, 0.08f, true, 1.0f, 2.0f), P("M28.0,30.0a4.0,4.0 0 1,0 8.0,0a4.0,4.0 0 1,0 -8.0,0z", true, 1.0f, false, 1.0f, 2.0f)),
        "send" to listOf(P("M10,32 L50,14 L40,50 L32,36 Z", true, 0.08f, true, 1.0f, 2.0f), P("M32 36 L50 14", false, 1.0f, true, 1.0f, 2.0f), P("M29.6,36.0a2.4,2.4 0 1,0 4.8,0a2.4,2.4 0 1,0 -4.8,0z", true, 1.0f, false, 1.0f, 2.0f)),
        "download" to listOf(P("M32 12 L32 40", false, 1.0f, true, 1.0f, 2.2f), P("M20 32 L32 46 L44 32", false, 1.0f, true, 1.0f, 2.0f), P("M16 52 H48", false, 1.0f, true, 1.0f, 2.0f)),
        "copy" to listOf(P("M20.0,18.0h28.0v34.0h-28.0z", true, 0.08f, true, 1.0f, 2.0f), P("M14.0,12.0h28.0v34.0h-28.0z", true, 0.04f, true, 1.0f, 2.0f), P("M25.8,28.0a2.2,2.2 0 1,0 4.4,0a2.2,2.2 0 1,0 -4.4,0z", true, 1.0f, false, 1.0f, 2.0f)),
        "share" to listOf(P("M42.0,16.0a4.0,4.0 0 1,0 8.0,0a4.0,4.0 0 1,0 -8.0,0z", true, 1.0f, false, 1.0f, 2.0f), P("M42.0,48.0a4.0,4.0 0 1,0 8.0,0a4.0,4.0 0 1,0 -8.0,0z", true, 1.0f, false, 1.0f, 2.0f), P("M12.0,32.0a4.0,4.0 0 1,0 8.0,0a4.0,4.0 0 1,0 -8.0,0z", true, 1.0f, false, 1.0f, 2.0f), P("M20 30 L42 18", false, 1.0f, true, 1.0f, 2.0f), P("M20 34 L42 46", false, 1.0f, true, 1.0f, 2.0f)),
        "check" to listOf(P("M14 34 L26 46 L50 18", false, 1.0f, true, 1.0f, 2.4f), P("M23.6,46.0a2.4,2.4 0 1,0 4.8,0a2.4,2.4 0 1,0 -4.8,0z", true, 1.0f, false, 1.0f, 2.0f)),
        "close" to listOf(P("M18 18 L46 46", false, 1.0f, true, 1.0f, 2.4f), P("M46 18 L18 46", false, 1.0f, true, 1.0f, 2.4f), P("M29.0,32.0a3.0,3.0 0 1,0 6.0,0a3.0,3.0 0 1,0 -6.0,0z", true, 1.0f, false, 1.0f, 2.0f)),
        "chevron-left" to listOf(P("M40 14 L22 32 L40 50", false, 1.0f, true, 1.0f, 2.2f)),
        "chevron-right" to listOf(P("M24 14 L42 32 L24 50", false, 1.0f, true, 1.0f, 2.2f)),
        "chevron-down" to listOf(P("M14 24 L32 42 L50 24", false, 1.0f, true, 1.0f, 2.2f)),
        "plus" to listOf(P("M32 14 L32 50", false, 1.0f, true, 1.0f, 2.4f), P("M14 32 H50", false, 1.0f, true, 1.0f, 2.4f), P("M29.0,32.0a3.0,3.0 0 1,0 6.0,0a3.0,3.0 0 1,0 -6.0,0z", true, 1.0f, false, 1.0f, 2.0f)),
        "lock" to listOf(P("M16.0,28.0h32.0v22.0h-32.0z", true, 0.08f, true, 1.0f, 2.0f), P("M22 28 V20 C22 12 42 12 42 20 V28", false, 1.0f, true, 1.0f, 2.0f), P("M29.2,38.0a2.8,2.8 0 1,0 5.6,0a2.8,2.8 0 1,0 -5.6,0z", true, 1.0f, false, 1.0f, 2.0f)),
        "key" to listOf(P("M14.0,32.0a8.0,8.0 0 1,0 16.0,0a8.0,8.0 0 1,0 -16.0,0z", false, 1.0f, true, 1.0f, 2.0f), P("M30 32 H52", false, 1.0f, true, 1.0f, 2.0f), P("M44 32 L44 40", false, 1.0f, true, 1.0f, 2.0f), P("M50 32 L50 38", false, 1.0f, true, 1.0f, 2.0f), P("M19.4,32.0a2.6,2.6 0 1,0 5.2,0a2.6,2.6 0 1,0 -5.2,0z", true, 1.0f, false, 1.0f, 2.0f)),
        "eye" to listOf(P("M8 32 C16 18 48 18 56 32 C48 46 16 46 8 32 Z", true, 0.07f, true, 1.0f, 2.0f), P("M27.0,32.0a5.0,5.0 0 1,0 10.0,0a5.0,5.0 0 1,0 -10.0,0z", true, 1.0f, false, 1.0f, 2.0f), P("M30.0,32.0a2.0,2.0 0 1,0 4.0,0a2.0,2.0 0 1,0 -4.0,0z", false, 1.0f, true, 1.0f, 2.0f)),
        "eye-off" to listOf(P("M10 32 C16 22 24 16 32 16", false, 1.0f, true, 1.0f, 1.8f), P("M54 32 C48 42 40 48 32 48", false, 1.0f, true, 1.0f, 1.8f), P("M28.0,32.0a4.0,4.0 0 1,0 8.0,0a4.0,4.0 0 1,0 -8.0,0z", false, 1.0f, true, 1.0f, 2.0f), P("M16 16 L48 48", false, 1.0f, true, 1.0f, 2.2f)),
        "sun" to listOf(P("M24.0,32.0a8.0,8.0 0 1,0 16.0,0a8.0,8.0 0 1,0 -16.0,0z", true, 1.0f, false, 1.0f, 2.0f), P("M32 10 L32 16", false, 1.0f, true, 1.0f, 2.0f), P("M32 48 L32 54", false, 1.0f, true, 1.0f, 2.0f), P("M10 32 H16", false, 1.0f, true, 1.0f, 2.0f), P("M48 32 H54", false, 1.0f, true, 1.0f, 2.0f), P("M16 16 L20 20", false, 1.0f, true, 1.0f, 2.0f), P("M44 44 L48 48", false, 1.0f, true, 1.0f, 2.0f), P("M16 48 L20 44", false, 1.0f, true, 1.0f, 2.0f), P("M44 20 L48 16", false, 1.0f, true, 1.0f, 2.0f)),
        "moon" to listOf(P("M36 12 C22 16 16 30 22 42 C28 52 42 52 48 46 C38 48 26 40 28 26 C30 18 34 14 36 12 Z", true, 0.1f, true, 1.0f, 2.0f)),
        "phone" to listOf(P("M18 14 H28 L32 24 L26 28 C30 36 34 40 42 44 L46 38 L56 42 V50 C56 52 40 54 28 42 C16 30 14 16 18 14 Z", true, 0.08f, true, 1.0f, 2.0f), P("M28.0,22.0a2.0,2.0 0 1,0 4.0,0a2.0,2.0 0 1,0 -4.0,0z", true, 1.0f, false, 1.0f, 2.0f)),
        "dots" to listOf(P("M13.0,32.0a3.0,3.0 0 1,0 6.0,0a3.0,3.0 0 1,0 -6.0,0z", true, 1.0f, false, 1.0f, 2.0f), P("M29.0,32.0a3.0,3.0 0 1,0 6.0,0a3.0,3.0 0 1,0 -6.0,0z", true, 1.0f, false, 1.0f, 2.0f), P("M45.0,32.0a3.0,3.0 0 1,0 6.0,0a3.0,3.0 0 1,0 -6.0,0z", true, 1.0f, false, 1.0f, 2.0f)),
        "external" to listOf(P("M12.0,18.0h34.0v34.0h-34.0z", true, 0.06f, true, 1.0f, 2.0f), P("M30 14 H52", false, 1.0f, true, 1.0f, 2.0f), P("M52 14 L52 36", false, 1.0f, true, 1.0f, 2.0f), P("M32 34 L50 16", false, 1.0f, true, 1.0f, 2.2f)),
        "refresh" to listOf(P("M46 28 A16 16 0 1 0 48 36", false, 1.0f, true, 1.0f, 2.2f), P("M40 16 L48 28 L36 30", false, 1.0f, true, 1.0f, 2.0f)),
        "user-plus" to listOf(P("M17.0,20.0a7.0,7.0 0 1,0 14.0,0a7.0,7.0 0 1,0 -14.0,0z", false, 1.0f, true, 1.0f, 2.0f), P("M8 50 C10 38 38 38 40 50", true, 0.07f, true, 1.0f, 2.0f), P("M48 18 L48 34", false, 1.0f, true, 1.0f, 2.0f), P("M40 26 H56", false, 1.0f, true, 1.0f, 2.0f)),
        "users" to listOf(P("M17.0,20.0a7.0,7.0 0 1,0 14.0,0a7.0,7.0 0 1,0 -14.0,0z", false, 1.0f, true, 1.0f, 2.0f), P("M37.0,22.0a5.0,5.0 0 1,0 10.0,0a5.0,5.0 0 1,0 -10.0,0z", false, 1.0f, true, 1.0f, 2.0f), P("M10 50 C12 38 36 38 38 50", true, 0.08f, true, 1.0f, 2.0f), P("M36 48 C38 38 54 38 54 48", false, 1.0f, true, 1.0f, 1.6f)),
        "server" to listOf(P("M12.0,12.0h40.0v14.0h-40.0z", true, 0.08f, true, 1.0f, 2.0f), P("M12.0,28.0h40.0v14.0h-40.0z", true, 0.05f, true, 1.0f, 2.0f), P("M12.0,44.0h40.0v10.0h-40.0z", true, 0.1f, true, 1.0f, 2.0f), P("M18.0,19.0a2.0,2.0 0 1,0 4.0,0a2.0,2.0 0 1,0 -4.0,0z", true, 1.0f, false, 1.0f, 2.0f), P("M18.0,35.0a2.0,2.0 0 1,0 4.0,0a2.0,2.0 0 1,0 -4.0,0z", true, 1.0f, false, 1.0f, 2.0f), P("M18.0,49.0a2.0,2.0 0 1,0 4.0,0a2.0,2.0 0 1,0 -4.0,0z", true, 1.0f, false, 1.0f, 2.0f)),
        "bookmark" to listOf(P("M18,12 L46,12 L46,52 L32,40 L18,52 Z", true, 0.08f, true, 1.0f, 2.0f), P("M29.4,24.0a2.6,2.6 0 1,0 5.2,0a2.6,2.6 0 1,0 -5.2,0z", true, 1.0f, false, 1.0f, 2.0f)),
        "clock" to listOf(P("M14.0,32.0a18.0,18.0 0 1,0 36.0,0a18.0,18.0 0 1,0 -36.0,0z", false, 1.0f, true, 1.0f, 2.0f), P("M32 32 L32 20", false, 1.0f, true, 1.0f, 2.0f), P("M32 32 L42 36", false, 1.0f, true, 1.0f, 2.0f), P("M29.6,32.0a2.4,2.4 0 1,0 4.8,0a2.4,2.4 0 1,0 -4.8,0z", true, 1.0f, false, 1.0f, 2.0f)),
        "alert" to listOf(P("M32,10 L54,50 L10,50 Z", true, 0.08f, true, 1.0f, 2.0f), P("M32 24 L32 36", false, 1.0f, true, 1.0f, 2.2f), P("M29.8,42.0a2.2,2.2 0 1,0 4.4,0a2.2,2.2 0 1,0 -4.4,0z", true, 1.0f, false, 1.0f, 2.0f)),
        "info" to listOf(P("M14.0,32.0a18.0,18.0 0 1,0 36.0,0a18.0,18.0 0 1,0 -36.0,0z", false, 1.0f, true, 1.0f, 2.0f), P("M32 28 L32 44", false, 1.0f, true, 1.0f, 2.2f), P("M29.6,20.0a2.4,2.4 0 1,0 4.8,0a2.4,2.4 0 1,0 -4.8,0z", true, 1.0f, false, 1.0f, 2.0f)),
        "link" to listOf(P("M26 38 L22 42 C16 48 16 54 24 54 C28 54 32 50 34 46", false, 1.0f, true, 1.0f, 2.0f), P("M38 26 L42 22 C48 16 48 10 40 10 C36 10 32 14 30 18", false, 1.0f, true, 1.0f, 2.0f), P("M26 38 L38 26", false, 1.0f, true, 1.0f, 2.2f)),
        "search" to listOf(P("M16.0,28.0a12.0,12.0 0 1,0 24.0,0a12.0,12.0 0 1,0 -24.0,0z", false, 1.0f, true, 1.0f, 2.0f), P("M37 37 L52 52", false, 1.0f, true, 1.0f, 2.4f), P("M25.0,28.0a3.0,3.0 0 1,0 6.0,0a3.0,3.0 0 1,0 -6.0,0z", true, 1.0f, false, 1.0f, 2.0f)),
        "scan" to listOf(P("M14 22 V14 H22", false, 1.0f, true, 1.0f, 2.0f), P("M42 14 H50 V22", false, 1.0f, true, 1.0f, 2.0f), P("M14 42 V50 H22", false, 1.0f, true, 1.0f, 2.0f), P("M50 42 V50 H42", false, 1.0f, true, 1.0f, 2.0f), P("M18 32 H46", false, 1.0f, true, 1.0f, 2.0f), P("M29.0,32.0a3.0,3.0 0 1,0 6.0,0a3.0,3.0 0 1,0 -6.0,0z", true, 1.0f, false, 1.0f, 2.0f)),
        "power" to listOf(P("M24 18 C16 22 12 30 14 40 C16 50 26 56 36 52 C46 48 50 36 46 26 C44 22 40 18 40 18", false, 1.0f, true, 1.0f, 2.2f), P("M32 10 L32 32", false, 1.0f, true, 1.0f, 2.2f)),
        "cpu" to listOf(P("M18.0,18.0h28.0v28.0h-28.0z", true, 0.08f, true, 1.0f, 2.0f), P("M26.0,26.0h12.0v12.0h-12.0z", true, 0.16f, true, 1.0f, 2.0f), P("M24 18 L24 12", false, 1.0f, true, 1.0f, 2.0f), P("M32 18 L32 12", false, 1.0f, true, 1.0f, 2.0f), P("M40 18 L40 12", false, 1.0f, true, 1.0f, 2.0f), P("M24 46 L24 52", false, 1.0f, true, 1.0f, 2.0f), P("M32 46 L32 52", false, 1.0f, true, 1.0f, 2.0f), P("M40 46 L40 52", false, 1.0f, true, 1.0f, 2.0f), P("M18 24 H12", false, 1.0f, true, 1.0f, 2.0f), P("M18 32 H12", false, 1.0f, true, 1.0f, 2.0f), P("M18 40 H12", false, 1.0f, true, 1.0f, 2.0f), P("M46 24 H52", false, 1.0f, true, 1.0f, 2.0f), P("M46 32 H52", false, 1.0f, true, 1.0f, 2.0f), P("M46 40 H52", false, 1.0f, true, 1.0f, 2.0f)),
        "bolt" to listOf(P("M34,8 L18,34 L30,34 L26,56 L46,28 L34,28 Z", true, 0.1f, true, 1.0f, 2.0f)),
        "star" to listOf(P("M32,10 L37,24 L52,24 L40,34 L44,50 L32,40 L20,50 L24,34 L12,24 L27,24 Z", true, 0.1f, true, 1.0f, 2.0f)),
        "activity" to listOf(P("M8 34 H18 L24 18 L32 46 L40 26 L46 34 H56", false, 1.0f, true, 1.0f, 2.2f)),
        "box" to listOf(P("M32,10 L52,20 L52,44 L32,54 L12,44 L12,20 Z", true, 0.06f, true, 1.0f, 2.0f), P("M32 10 L32 32", false, 1.0f, true, 1.0f, 2.0f), P("M12 20 L32 32", false, 1.0f, true, 1.0f, 2.0f), P("M52 20 L32 32", false, 1.0f, true, 1.0f, 2.0f), P("M29.6,32.0a2.4,2.4 0 1,0 4.8,0a2.4,2.4 0 1,0 -4.8,0z", true, 1.0f, false, 1.0f, 2.0f)),
        "edit" to listOf(P("M14,50 L17,39 L41,15 L49,23 L25,47 Z", true, 0.08f, true, 1.0f, 2.0f), P("M36 20 L44 28", false, 1.0f, true, 1.0f, 2.0f), P("M34 50 H50", false, 1.0f, true, 1.0f, 2.0f), P("M15.3,46.5a2.2,2.2 0 1,0 4.4,0a2.2,2.2 0 1,0 -4.4,0z", true, 1.0f, false, 1.0f, 2.0f)),
        "mine" to listOf(P("M32,8 L50,28 L32,56 L14,28 Z", true, 0.08f, true, 1.0f, 2.0f), P("M14 28 H50", false, 1.0f, true, 1.0f, 1.6f), P("M32 8 L26 28 L32 56 L38 28 Z", true, 0.1f, true, 1.0f, 1.6f), P("M29.0,28.0a3.0,3.0 0 1,0 6.0,0a3.0,3.0 0 1,0 -6.0,0z", true, 1.0f, false, 1.0f, 2.0f), P("M52 10 L56 6", false, 1.0f, true, 1.0f, 2.0f), P("M54 16 H58", false, 1.0f, true, 1.0f, 2.0f)),
        "trash" to listOf(P("M18.0,22.0h28.0v30.0h-28.0z", true, 0.06f, true, 1.0f, 2.0f), P("M12 22 H52", false, 1.0f, true, 1.0f, 2.0f), P("M26 22 V14 H38 V22", false, 1.0f, true, 1.0f, 2.0f), P("M28 30 V44", false, 1.0f, true, 1.0f, 2.0f), P("M36 30 V44", false, 1.0f, true, 1.0f, 2.0f)),
        "receive" to listOf(P("M12.0,38.0h40.0v14.0h-40.0z", true, 0.08f, true, 1.0f, 2.0f), P("M32 10 L32 36", false, 1.0f, true, 1.0f, 2.2f), P("M22 26 L32 38 L42 26", false, 1.0f, true, 1.0f, 2.0f), P("M29.6,45.0a2.4,2.4 0 1,0 4.8,0a2.4,2.4 0 1,0 -4.8,0z", true, 1.0f, false, 1.0f, 2.0f)),
        "approve" to listOf(P("M32,8 L50,16 L48,34 L32,56 L16,34 L14,16 Z", true, 0.08f, true, 1.0f, 2.0f), P("M23 30 L30 37 L42 23", false, 1.0f, true, 1.0f, 2.4f), P("M27.8,37.0a2.2,2.2 0 1,0 4.4,0a2.2,2.2 0 1,0 -4.4,0z", true, 1.0f, false, 1.0f, 2.0f)),
        "dapps" to listOf(P("M10.0,12.0h44.0v40.0h-44.0z", true, 0.06f, true, 1.0f, 2.0f), P("M10 22 H54", false, 1.0f, true, 1.0f, 2.0f), P("M14.2,17.0a1.8,1.8 0 1,0 3.6,0a1.8,1.8 0 1,0 -3.6,0z", true, 1.0f, false, 1.0f, 2.0f), P("M20.2,17.0a1.8,1.8 0 1,0 3.6,0a1.8,1.8 0 1,0 -3.6,0z", true, 1.0f, false, 1.0f, 2.0f), P("M32,28 L40,37 L32,46 L24,37 Z", true, 0.14f, true, 1.0f, 2.0f), P("M29.8,37.0a2.2,2.2 0 1,0 4.4,0a2.2,2.2 0 1,0 -4.4,0z", true, 1.0f, false, 1.0f, 2.0f)),
        "network" to listOf(P("M28.0,14.0a4.0,4.0 0 1,0 8.0,0a4.0,4.0 0 1,0 -8.0,0z", true, 1.0f, false, 1.0f, 2.0f), P("M10.0,46.0a4.0,4.0 0 1,0 8.0,0a4.0,4.0 0 1,0 -8.0,0z", true, 1.0f, false, 1.0f, 2.0f), P("M46.0,46.0a4.0,4.0 0 1,0 8.0,0a4.0,4.0 0 1,0 -8.0,0z", true, 1.0f, false, 1.0f, 2.0f), P("M32,18 L47,44 L17,44 Z", true, 0.07f, true, 1.0f, 2.0f), P("M29.6,35.0a2.4,2.4 0 1,0 4.8,0a2.4,2.4 0 1,0 -4.8,0z", true, 1.0f, false, 1.0f, 2.0f)),
        "token" to listOf(P("M14.0,32.0a18.0,18.0 0 1,0 36.0,0a18.0,18.0 0 1,0 -36.0,0z", true, 0.06f, true, 1.0f, 2.0f), P("M32,20 L41,32 L32,44 L23,32 Z", true, 0.14f, true, 1.0f, 2.0f), P("M29.6,32.0a2.4,2.4 0 1,0 4.8,0a2.4,2.4 0 1,0 -4.8,0z", true, 1.0f, false, 1.0f, 2.0f)),
        "phrase" to listOf(P("M12.0,14.0h40.0v36.0h-40.0z", true, 0.06f, true, 1.0f, 2.0f), P("M18 24 H28", false, 1.0f, true, 1.0f, 2.0f), P("M36 24 H46", false, 1.0f, true, 1.0f, 2.0f), P("M18 32 H28", false, 1.0f, true, 1.0f, 2.0f), P("M36 32 H46", false, 1.0f, true, 1.0f, 2.0f), P("M18 40 H28", false, 1.0f, true, 1.0f, 2.0f), P("M38.6,40.0a2.4,2.4 0 1,0 4.8,0a2.4,2.4 0 1,0 -4.8,0z", true, 1.0f, false, 1.0f, 2.0f)),
        "restore" to listOf(P("M18 36 A16 16 0 1 0 20 22", false, 1.0f, true, 1.0f, 2.2f), P("M12 14 L20 24 L30 18", false, 1.0f, true, 1.0f, 2.0f), P("M31.0,34.0a3.0,3.0 0 1,0 6.0,0a3.0,3.0 0 1,0 -6.0,0z", true, 1.0f, false, 1.0f, 2.0f)),
    )

    /** Lines are drawn 1.6x thicker than the pack (made for 48-64 px) so they stay crisp at 20-28 dp. */
    operator fun get(name: String): ImageVector = cache.getOrPut(name) {
        val b = ImageVector.Builder(name = name, defaultWidth = 24.dp, defaultHeight = 24.dp, viewportWidth = 64f, viewportHeight = 64f)
        for (p in defs[name] ?: emptyList()) {
            b.addPath(
                pathData = PathParser().parsePathString(p.d).toNodes(),
                fill = if (p.fill) SolidColor(Color.Black) else null, fillAlpha = p.fillAlpha,
                stroke = if (p.stroke) SolidColor(Color.Black) else null, strokeAlpha = p.strokeAlpha,
                strokeLineWidth = p.width * 1.6f, strokeLineCap = StrokeCap.Square, strokeLineJoin = StrokeJoin.Miter,
            )
        }
        b.build()
    }
}
