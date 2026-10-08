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
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

// The certificate verifier's Kotlin half (desktop/src/android_tls.rs): rustls-platform-verifier
// calls into `org.rustls.platformverifier`, shipped as an .aar inside the
// `rustls-platform-verifier-android` crate rather than on Maven. Found where cargo put it, at build
// time - the path is each machine's own registry - and handed over as the file itself: as a Maven
// repository with artifact-only metadata, Gradle looked for a .jar (field-found, 2026-10-08), and
// the .aar has no dependencies of its own to lose by skipping its .pom.
val rustlsPlatformVerifierAar: File = run {
    val metadata = providers.exec {
        commandLine(
            "cargo", "metadata", "--format-version", "1",
            "--filter-platform", "aarch64-linux-android",
            "--manifest-path", rootProject.file("../../Cargo.toml").path,
        )
    }.standardOutput.asText.get()
    @Suppress("UNCHECKED_CAST")
    val packages = (groovy.json.JsonSlurper().parseText(metadata) as Map<String, Any>)["packages"]
        as List<Map<String, Any>>
    val manifest = packages.firstOrNull { it["name"] == "rustls-platform-verifier-android" }
        ?.get("manifest_path") as String?
        ?: error("rustls-platform-verifier-android is not in the Android dependency graph")
    File(File(manifest).parentFile, "maven").walkTopDown()
        .filter { it.name.endsWith(".aar") }
        .sortedBy { it.name }
        .lastOrNull()
        ?: error("no .aar in the rustls-platform-verifier-android crate")
}

dependencies {
    implementation(files(rustlsPlatformVerifierAar))
}

apply(from = "tauri.build.gradle.kts")