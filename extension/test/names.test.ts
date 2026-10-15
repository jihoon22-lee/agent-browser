import { accessibleName } from "../src/content/dom";

it("names icon links and buttons from nested alt text and aria-label", () => {
  document.body.innerHTML = `<a id="home" href="/"><img alt="쇼핑몰 홈" src="x.png"></a>
    <button id="del"><i aria-label="삭제"></i></button><button id="plain">저장</button>`;
  expect(accessibleName(document.getElementById("home")!)).toBe("쇼핑몰 홈");
  expect(accessibleName(document.getElementById("del")!)).toBe("삭제");
  expect(accessibleName(document.getElementById("plain")!)).toBe("저장");
});
