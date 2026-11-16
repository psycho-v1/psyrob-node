import java.util.Properties

plugins {
    id("com.android.application") version "8.13.0"
    id("org.jetbrains.kotlin.android") version "2.2.21"
    id("org.jetbrains.kotlin.plugin.compose") version "2.2.21"
}

// Release signing: keystore path, password file and alias come from signing.properties or the environment (never committed).
val signing = Properties().apply { rootProject.file("signing.properties").takeIf { it.exists() }?.inputStream()?.use { load(it) } }
fun sig(key: String, env: String): String? = signing.getProperty(key) ?: System.getenv(env)

android {
    namespace = "com.psyrob.suite"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.psyrob.suite"
        minSdk = 24
        targetSdk = 35
        versionCode = 2
        versionName = "Beta 1.0"
    }

    signingConfigs {
        create("release") {
            val store = sig("storeFile", "KEYSTORE")
            if (store != null) {
                storeFile = file(store)
                storePassword = sig("storePasswordFile", "KEYSTORE_PASS_FILE")?.let { file(it).readText().trim() } ?: sig("storePassword", "KEYSTORE_PASS")
                keyAlias = sig("keyAlias", "KEY_ALIAS") ?: "psyminer"
                keyPassword = storePassword
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (sig("storeFile", "KEYSTORE") != null) signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures { compose = true; buildConfig = false }
    packaging { resources { excludes += setOf("/META-INF/{AL2.0,LGPL2.1}", "/META-INF/*.version", "DebugProbesKt.bin", "kotlin-tooling-metadata.json") } }
    testOptions { unitTests { isIncludeAndroidResources = true } }
    dependenciesInfo { includeInApk = false; includeInBundle = false }
}

kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }

dependencies {
    val bom = platform("androidx.compose:compose-bom:2025.12.01")
    implementation(bom)
    implementation("androidx.activity:activity-compose:1.12.4")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.animation:animation")
    implementation("com.google.zxing:core:3.5.3")

    // screenshot checks of the Compose screens on the JVM (not part of the APK)
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.robolectric:robolectric:4.16")
    testImplementation("androidx.compose.ui:ui-test-junit4")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
}
