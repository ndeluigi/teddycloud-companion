import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Your deployment: android/companion.properties (gitignored, see companion.properties.example)
//   site=https://storie.example.com      the companion server the app wraps
//   applicationId=com.example.storie     package name (keep it stable: it identifies the app)
//   appName=Storie                       launcher label
val companionProps = Properties().apply {
    val f = rootProject.file("companion.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}
val site = companionProps.getProperty("site") ?: "https://companion.example.com"
val appId = companionProps.getProperty("applicationId") ?: "app.teddycloud.companion"
val appName = companionProps.getProperty("appName") ?: "Storie"

// Release signing from keystore/keystore.properties (gitignored, keep a backup elsewhere).
// The signature is what lets a new build install over its predecessor: lose the key and
// every phone has to uninstall and start over.
val keystorePropertiesFile = rootProject.file("keystore/keystore.properties")
val keystoreProperties = Properties().apply {
    if (keystorePropertiesFile.exists()) keystorePropertiesFile.inputStream().use { load(it) }
}

android {
    namespace = "app.teddycloud.companion"
    compileSdk = 35

    defaultConfig {
        applicationId = appId
        minSdk = 26
        targetSdk = 35
        // bump both before publishing: versionCode is what the updater compares,
        // versionName is what the phone shows a person
        versionCode = 3
        versionName = "1.0.2"
        buildConfigField("String", "SITE", "\"$site\"")
        manifestPlaceholders["appName"] = appName
    }

    buildFeatures { buildConfig = true }

    signingConfigs {
        create("release") {
            if (keystorePropertiesFile.exists()) {
                storeFile = rootProject.file(keystoreProperties["storeFile"] as String)
                storePassword = keystoreProperties["storePassword"] as String
                keyAlias = keystoreProperties["keyAlias"] as String
                keyPassword = keystoreProperties["keyPassword"] as String
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            if (keystorePropertiesFile.exists()) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-ktx:1.9.3")
    // background audio with a media notification / lock-screen controls
    implementation("androidx.media3:media3-exoplayer:1.4.1")
    implementation("androidx.media3:media3-session:1.4.1")
}
