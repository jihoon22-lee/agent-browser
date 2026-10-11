import { isExtensionPage } from "../src/background/sender";

const ID = "icgmjjcpnaenpfjfoggnaodeaidbnihl";

describe("isExtensionPage", () => {
  it("accepts the options page even though it is opened in a tab", () => {
    expect(isExtensionPage({ id: ID, url: `chrome-extension://${ID}/src/options/index.html`, tab: { id: 5 } }, ID)).toBe(true);
  });
  it("accepts the side panel", () => {
    expect(isExtensionPage({ id: ID, url: `chrome-extension://${ID}/src/sidepanel/index.html` }, ID)).toBe(true);
  });
  it("rejects a content script running in a web page", () => {
    expect(isExtensionPage({ id: ID, url: "https://example.com/", tab: { id: 5 } }, ID)).toBe(false);
  });
  it("rejects another extension and missing sender data", () => {
    expect(isExtensionPage({ id: "otherextensionidotherextensionid", url: `chrome-extension://${ID}/x` }, ID)).toBe(false);
    expect(isExtensionPage({}, ID)).toBe(false);
  });
});
