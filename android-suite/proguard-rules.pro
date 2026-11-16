# The dApp browser's JavaScript bridge is called by name from the page.
-keepclassmembers class com.psyrob.suite.app.BrowserCore$ProviderBridge { @android.webkit.JavascriptInterface <methods>; }
-keepattributes JavascriptInterface
