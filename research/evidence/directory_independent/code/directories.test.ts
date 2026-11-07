import { expect, it, vi } from "vitest";
import { Fetcher } from "../../connectors/fetcher";
import { schoolLinks, branchPoint, institutionPages, organizationLinks, discoverSeattleDirectories, SEATTLE_DIRECTORIES } from "../../discovery/directories";
import type { DiscoveryContext } from "../../discovery/methods";

it("selects a school from directory labels, not a guessed neighborhood hostname", () => {
  const card = (name: string, host: string) => `<div class="list-item"><h4 class="list-item-title">${name} Elementary</h4><a href="https://${host}.seattleschools.org/">Website</a></div>`;
  const html = card("Maple", "unexpected-code") + card("Other", "maple");
  expect(schoolLinks(html, "https://www.seattleschools.org/schools/", "Maple")).toEqual([{ url: "https://unexpected-code.seattleschools.org/", text: "Maple Elementary" }]);
  expect(schoolLinks(html, "https://www.seattleschools.org/schools/", "Pine")).toEqual([]);
});
it("extracts actual branch coordinates and rejects missing or invalid coordinates", () => {
  expect(branchPoint('<div data-map-markerlat="47.678" data-map-markerlng="-122.29"></div>')).toEqual([-122.29, 47.678]);
  expect(branchPoint('<div data-map-markerlat="999" data-map-markerlng="1"></div>')).toBeNull();
  expect(branchPoint('<h1>Northeast Branch</h1>')).toBeNull();
});
it("preserves branch-specific event navigation and excludes other branches and story URLs", () => {
  const html = '<a href="/hours-and-locations/a-branch/events">Events</a><a href="/hours-and-locations/b-branch/events">Events</a><a href="https://other.org/news">News</a><a href="/2026/11/01/news">News</a>';
  expect(institutionPages(html, "https://library.org/hours-and-locations/a-branch", true).map(x => x.url)).toEqual(['https://library.org/hours-and-locations/a-branch/events']);
});
function pdfFixture() {
  const stream = 'BT /F1 12 Tf 50 700 Td (Maple Community Council) Tj 0 -30 Td (Other Council) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R /Annots [6 0 R 7 0 R] >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, '<< /Type /Annot /Subtype /Link /Rect [48 695 300 715] /A << /S /URI /URI (https://council.example.org/) >> >>', '<< /Type /Annot /Subtype /Link /Rect [48 665 300 685] /A << /S /URI /URI (https://maple-unrelated.example.org/) >> >>'];
  let text = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, i) => { offsets.push(text.length); text += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = text.length;
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.slice(1).map(x => `${String(x).padStart(10, '0')} 00000 n \n`).join('');
  text += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(text);
}
it("binds PDF organization labels to link annotations rather than matching URL substrings", async () => {
  expect(await organizationLinks(pdfFixture(), "Maple")).toEqual([{url:'https://council.example.org/',text:'Maple Community Council'}]);
  await expect(organizationLinks(new TextEncoder().encode('not pdf'), 'Maple')).rejects.toThrow('not a PDF');
});
it("does not use Seattle directories for another jurisdiction", async () => {
  const context = { location: { state: 'WA', community: { parent_name: 'Spokane' } } } as DiscoveryContext;
  expect((await discoverSeattleDirectories(context)).candidates).toEqual([]);
});

it("discovers all three institution types without reading a source database and retains successes when a linked source is blocked", async () => {
  const body = `<main>${"Public institution information and community updates. ".repeat(8)}</main>`;
  const school = 'https://code.seattleschools.org/';
  const branch = 'https://www.spl.org/hours-and-locations/example-branch';
  const pages: Record<string, string> = {
    [SEATTLE_DIRECTORIES.schools]: '<div class="list-item"><h4 class="list-item-title">Maple Elementary</h4><a href="https://code.seattleschools.org/">Website</a></div>',
    [school]: body + '<a href="/calendar/">Calendar</a><a href="https://pta.example.org/">PTA</a>',
    [school + 'calendar/']: body,
    [SEATTLE_DIRECTORIES.libraries]: `<a href="${branch}">Example Branch</a><a href="/hours-and-locations/distant-branch">Distant Branch</a>`,
    [branch]: body + '<div data-map-markerlat="47.678" data-map-markerlng="-122.29"></div><a href="/hours-and-locations/example-branch/events">Events</a>',
    [branch + '/events']: body,
    'https://www.spl.org/hours-and-locations/distant-branch': body + '<div data-map-markerlat="47.4" data-map-markerlng="-122.3"></div>',
    [SEATTLE_DIRECTORIES.organizations]: '<base href="/"><a href="documents/Districts/all.pdf">District directory</a>',
    'https://council.example.org/': body + '<a href="/meetings/">Meetings</a>',
    'https://council.example.org/meetings/': body,
  };
  const getText = vi.spyOn(Fetcher.prototype, 'getText').mockImplementation(async url => {
    if (!(url in pages)) throw new Error('robots blocked');
    return [url, pages[url]];
  });
  const get = vi.spyOn(Fetcher.prototype, 'get').mockImplementation(async url => [url, pdfFixture()]);
  try {
    const context = { location: { state: 'WA', latitude: 47.69, longitude: -122.29, community: { name: 'Maple', parent_name: 'Seattle' } }, db: { collection: () => { throw new Error('Registry/database access forbidden'); } } } as unknown as DiscoveryContext;
    const result = await discoverSeattleDirectories(context);
    expect(result.candidates.map(c => c.url)).toEqual(expect.arrayContaining([school, school + 'calendar/', branch, branch + '/events', 'https://council.example.org/', 'https://council.example.org/meetings/']));
    expect(result.candidates.every(c => c.found_by.method === 'directories' && c.inside_area === false)).toBe(true);
    expect(result.candidates.some(c => c.url?.includes('distant'))).toBe(false);
    expect(result.candidates.some(c => c.url?.includes('pta.example'))).toBe(false);
    expect(getText).toHaveBeenCalledWith('https://pta.example.org/', expect.any(Number), expect.any(String));
    expect(get).toHaveBeenCalledWith('https://www.seattle.gov/documents/Districts/all.pdf', expect.any(Number), 'application/pdf');
  } finally { vi.restoreAllMocks(); }
});
