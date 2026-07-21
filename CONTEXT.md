# AI News Tracking

This context collects posts from selected X accounts, groups related AI-industry stories, and distinguishes noteworthy events from content that should only be observed or ignored.

## Language

**Source Account**:
A monitored X account that publishes posts. A source account may represent a person, product, or organization and is not itself necessarily an Organization.
_Avoid_: Organization, publisher organization

**Organization**:
A canonical company or institution involved in a story, identified from a controlled registry. Products and people may be aliases or sources associated with an organization, but are not organizations themselves.
_Avoid_: Free-form company name, Source Account

**Post**:
A single X item collected from a Source Account, including original posts, quotes, replies, and reposts.
_Avoid_: Article, Topic

**Article**:
Long-form X content attached to a Post and retrievable as a complete body using the post's X identifier.
_Avoid_: Any post containing a URL

**Triage Decision**:
The editorial disposition assigned to a Post: Important, Observe, or Ignore.
_Avoid_: Boolean importance

**Important**:
A Post describing a concrete, noteworthy AI event that should enter active topic and metric tracking immediately.

**Observe**:
An AI- or technology-related Post that enters a Topic but requires audience evidence before promotion to Important.

**Ignore**:
A Post that is irrelevant, routine, or purely political without direct AI-industry impact and does not enter a Topic.

**Topic Candidate**:
A bilingual structured description of the real-world story inferred from one Post before matching against existing Topics.
_Avoid_: Free-form tag, category

**Topic**:
One real-world event or continuing story shared by one or more Posts, potentially from multiple Source Accounts and Organizations. A Topic owns the eventual report; individual Posts do not.
_Avoid_: Post, keyword, organization

**Active Topic**:
A Topic updated within the previous seven days and eligible to receive newly classified Posts.
_Avoid_: Trending topic, hot-list entry
