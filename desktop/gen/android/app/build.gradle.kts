import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

android {
    compileSdk = 36
    namespace = "net.lassam.ringtome"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "net.lassam.ringtome"
        minSdk = 24
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            isMinifyEnabled = true
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
        }
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
    buildFeatures {
        buildConfig = true
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    // hrseAmp on the phone (plans/AUDIO.md, section 10): Media3's player and media session - the
    // notification and lock-screen player, headphone buttons, Android Auto, and playing on in the
    // background (PlayerService.kt).
    implementation("androidx.media3:media3-exoplayer:1.8.0")
    implementation("androidx.media3:media3-session:1.8.0")
    implementation("com.google.guava:guava:33.4.8-android")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

// The certificate verifier's Kotlin half (desktop/src/android_tls.rs): rustls-platform-verifier
// calls into `org.rustls.platformverifier`, which since 0.2.0 of `rustls-platform-verifier-android`
// (rustls-platform-verifier 0.7.1) is published to a Maven repository on GitHub, no longer inside
// the crate - the crate's .aar was found here through `cargo metadata` until then. The version is
// the one desktop/Cargo.lock holds: the Rust half and the Kotlin half must be the same release.
// (0.1.1's verifier called every certificate without an OCSP address revoked - most of the web
// since its CAs moved to revocation lists - and every link preview on a phone failed with
// "invalid peer certificate: Revoked", field-found 2026-10-10.)
repositories {
    maven {
        url = uri("https://github.com/rustls/rustls-platform-verifier/raw/maven-archive/android-release-support/maven/")
        content { includeGroup("org.rustls") }
    }
}

val rustlsPlatformVerifierVersion: String = run {
    val lock = rootProject.file("../../Cargo.lock").readLines()
    val at = lock.indexOfFirst { it.trim() == "name = \"rustls-platform-verifier-android\"" }
    check(at >= 0) { "rustls-platform-verifier-android is not in desktop/Cargo.lock" }
    lock.drop(at + 1).first { it.trim().startsWith("version = ") }.substringAfter('"').substringBefore('"')
}

dependencies {
    implementation("org.rustls:rustls-platform-verifier:$rustlsPlatformVerifierVersion@aar")
}

apply(from = "tauri.build.gradle.kts")