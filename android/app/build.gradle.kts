plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
}

// API keys are read from `.env.local` (git-ignored), never from source code.
// Search order, first hit wins: <repo root>/.env.local (shared with the rest of TransFit),
// android/.env.local, then local.properties as a fallback.
fun readEnv(file: java.io.File): Map<String, String> =
    if (!file.exists()) emptyMap() else file.readLines()
        .map { it.trim() }
        .filter { it.isNotEmpty() && !it.startsWith("#") && it.contains("=") }
        .associate { line ->
            val i = line.indexOf('=')
            line.substring(0, i).trim() to line.substring(i + 1).trim().trim('"', '\'')
        }

val env: Map<String, String> =
    listOf(rootProject.file("local.properties"), rootProject.file(".env.local"), rootProject.file("../.env.local"))
        .fold(emptyMap()) { acc, f -> acc + readEnv(f) } // later files override earlier ones -> repo root wins

fun secret(vararg names: String): String =
    (names.firstNotNullOfOrNull { env[it] } ?: "").replace("\\", "\\\\").replace("\"", "\\\"")

android {
    namespace = "com.yj.departure"
    compileSdk = 37

    defaultConfig {
        applicationId = "com.yj.departure"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"

        // Kakao Local API REST key (place search). Empty string = feature disabled.
        buildConfigField("String", "KAKAO_REST_KEY", "\"${secret("KAKAO_REST_KEY")}\"")
        // Seoul Open Data key (real-time subway arrivals). Same name as the rest of TransFit: SUBWAY_KEY.
        buildConfigField("String", "SEOUL_SUBWAY_KEY", "\"${secret("SUBWAY_KEY", "SEOUL_SUBWAY_KEY")}\"")
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }
}

dependencies {
    implementation(platform("androidx.compose:compose-bom:2026.09.00"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.activity:activity-compose:1.13.0")
    implementation("androidx.core:core-ktx:1.19.1")
    implementation("com.google.android.gms:play-services-location:21.4.0")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303") // Android's org.json is stubbed in JVM unit tests
}
