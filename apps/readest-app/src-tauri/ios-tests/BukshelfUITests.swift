import XCTest

@MainActor
final class BukshelfUITests: XCTestCase {
  override func setUpWithError() throws {
    continueAfterFailure = false
  }

  func testLaunchesWebReaderShell() throws {
    let app = XCUIApplication()
    app.launch()

    XCTAssertTrue(app.wait(for: .runningForeground, timeout: 15))
    XCTAssertTrue(
      app.webViews.firstMatch.waitForExistence(timeout: 30),
      "Bukshelf should launch its reader WebView"
    )
  }
}
