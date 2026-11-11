import { describe, expect, it } from 'vitest';
import { addedClaims } from '../../model/news-blurb';
import { requiredDetails, validateItem, sourceBrief } from '../../model/story-writer';
const story = { id:'genealogy', title:'Genealogy Drop-In', kind:'event', description:'Free one-on-one genealogy help from the Seattle Genealogical Society. Registration is not required. Please contact LEAP at least seven days before the event to request accommodations.' };
describe('false holds and important reader conditions',()=>{
  it('accepts supported compound adjectives but still rejects invented free admission',()=>{
    expect(addedClaims('Enrollment can be stress-free.', ['Enrollment can be stress-free.'],5)).not.toContain('unsupported_claim_word:free');
    expect(addedClaims('Admission is free.', ['Enrollment can be stress-free.'],5)).toContain('unsupported_claim_word:free');
    expect(addedClaims('Admission is fee-free.', ['Enrollment can be stress-free.'],5)).toContain('unsupported_claim_word:free');
  });
  it('does not count street abbreviations as extra sentences',()=>{
    const text='Viewlands Elementary is at 10525 3rd Ave. NW, Seattle. It hosts an information session. Families can ask questions.';
    expect(addedClaims(text,[text],3)).not.toContain('too_many_sentences');
  });
  it('requires accessibility advance notice and optional registration',()=>{
    expect(requiredDetails(story).map(x=>x.id)).toEqual(['accommodation_notice','registration_optional']);
    expect(validateItem(story,{headline:story.title,summary:'Free one-on-one genealogy help from the Seattle Genealogical Society.'})).toEqual(expect.arrayContaining(['missing_important_detail:accommodation_notice','missing_important_detail:registration_optional']));
  });
  it('accepts equivalent seven and 7 wording but rejects the wrong notice period',()=>{
    const summary='Registration is not required. Contact LEAP 7 days in advance to request accommodations.';
    expect(validateItem(story,{headline:story.title,summary}).filter(x=>x.startsWith('missing_important_detail:'))).toEqual([]);
    expect(validateItem(story,{headline:story.title,summary:summary.replace('7 days','3 days')})).toContain('missing_important_detail:accommodation_notice');
  });
  it('keeps important conditions in the exact-source fallback and removes source field labels',()=>{
    const brief=sourceBrief({...story, verification_sources:[{id:'source-record',text:story.title+'\n'+story.description.replace('Registration is','Registration Required: Registration is')}]});
    expect(brief?.draft.summary).toContain('seven days before');
    expect(brief?.draft.summary).toContain('Registration is not required.');
    expect(brief?.draft.summary).not.toContain('Registration Required:');
  });
  it('never infers an accessibility deadline when the source gives none',()=>{
    expect(requiredDetails({...story,description:'Accommodations are available.'})).toEqual([]);
  });
});
it('preserves a death notice date and age instead of replacing them with generic remembrance',()=>{
 const obituary={id:'notice',title:'Remembering Darrell L. Syferd',kind:'obituary',description:'Darrell L. Syferd died on October 17, 2026, aged 92. He was born in Yakima.'};
 expect(validateItem(obituary,{headline:obituary.title,summary:'Darrell L. Syferd grew up in Yakima.'})).toEqual(expect.arrayContaining(['missing_important_detail:death_date','missing_important_detail:age_at_death']));
 expect(validateItem(obituary,{headline:obituary.title,summary:obituary.description}).filter(x=>x.startsWith('missing_important_detail:'))).toEqual([]);
});
it('does not convert a report date into the date a survey was conducted',()=>{
 const report={id:'survey',title:'NE 95th Street survey',kind:'local_news',source_date:'2026-05-10',description:'A May 10, 2026 report describes a survey on NE 95th Street. It had 236 respondents.'};
 expect(validateItem(report,{headline:report.title,summary:'The council conducted a survey on NE 95th Street from May 10, 2026.'})).toContain('unsupported_date_role:publication_date');
 expect(validateItem({...report,description:'The council conducted a survey on NE 95th Street from May 10, 2026.'},{headline:report.title,summary:'The council conducted a survey on NE 95th Street from May 10, 2026.'})).not.toContain('unsupported_date_role:publication_date');
});
it('does not turn a childhood location into lifelong residency or invent a memorial invitation',()=>{
 const obituary={id:'notice',title:'Remembering Darrell L. Syferd',kind:'obituary',description:'Darrell L. Syferd died on October 17, 2026, aged 92. He grew up in Yakima.'};
 const errors=validateItem(obituary,{headline:obituary.title,summary:'Darrell L. Syferd was a lifelong resident of Yakima. The community is invited to remember his life.'});
 expect(errors).toContain('summary:unsupported_residency_duration');
 expect(errors).toContain('summary:unsupported_memorial_invitation');
});
it('keeps a middle initial attached to the surname in a source brief',()=>{
 const title='Remembering Darrell L. Syferd';
 const description="The Co-op Funeral Home published a notice for Darrell L. Syferd. The notice states that he died on October 17, 2026, in Seattle, aged 92. He was born in Yakima.";
 const brief=sourceBrief({id:'notice',title,kind:'obituary',description});
 expect(brief?.draft.summary).toContain('Darrell L. Syferd.');
 expect(brief?.draft.summary).toContain('October 17, 2026');
});

it('keeps a sparse factual school-closure notice instead of requiring invented explanatory prose',()=>{
 const story={id:'closure',title:'No School Veterans Day',kind:'event',description:'Veterans Day, No School. Veterans Day Observed (no school).'};
 const brief=sourceBrief(story);
 expect(brief).toMatchObject({disposition:'checks_passed',source_brief:true});
 expect(brief?.draft.summary).toContain('No School.');
 expect(brief?.draft.summary).not.toContain('ceremony');
});
