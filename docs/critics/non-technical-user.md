# Meridian: A Non-Technical User's Brutally Honest Review

**Reviewer background**: I use Siri, Google Assistant, and Alexa daily. I can install apps, manage my phone, and troubleshoot basic Wi-Fi issues. I do not write code, manage servers, or know what a "container" is. A tech-savvy friend sent me this architecture document and asked for honest feedback from a "normal person" perspective.

**Bottom line up front**: Meridian sounds incredible on paper. The idea of an AI assistant that actually *does things* for me, learns my preferences, and keeps my data private? Sign me up. But after reading this document, I have no idea how I would actually use it, and I have serious doubts that anyone outside the developer community ever will.

---

## 1. Can I Even Install This Thing?

The installation section offers four options:

```
curl -fsSL https://meridian.dev/install.sh | sh
npm install -g @meridian/cli
docker run -d -p 3000:3000 -v meridian-data:/data meridian/meridian
docker compose up -d
```

I want to be very clear: **I do not know what any of these are.** These are four lines of what looks like computer code. I would need to open something called a "terminal" which I have never done. Where do I even type this? Is this the search bar?

Where is the "Download for Mac" button? Where is the .exe or .dmg file I double-click? Where is the App Store listing? Every app I use was either pre-installed on my phone or I tapped "Install" in a store. If Meridian cannot match that experience, it has already lost about 95% of the people who would actually benefit from a personal assistant.

The document says Meridian "ships as a single binary" -- great, but then immediately pivots to talking about `pkg`, Node.js, Docker Compose, YAML files, secrets, and volumes. None of these words mean anything to me.

**What I need**: A one-click installer with a setup wizard. Something like "Download Meridian for Mac," double-click it, it opens a friendly window that says "Welcome! Let's set up your assistant." That is the absolute minimum. Everything else is a developer tool, not a product for people.

---

## 2. I Need a PhD in Cartography Just to Understand What I Installed

To use Siri, I press a button and talk. To use Alexa, I say "Alexa." That is the entire onboarding.

Meridian has **six named components** I apparently need to understand:

- **Axis** -- the "deterministic runtime and scheduler"
- **Scout** -- the "planner LLM"
- **Sentinel** -- the "safety validator"
- **Journal** -- the "memory and Gear builder"
- **Bridge** -- the "user interface"
- **Gear** -- the "plugin system"

And then there is a concept called "fast path vs full path," something about "Sentinel Memory" that is different from "Journal Memory," "execution plans," "manifests," "sandboxes," and "provenance tagging."

I am sure all of this is important from an engineering standpoint. But as a user, I do not care that there are two separate safety systems, or that messages are signed with HMAC-SHA256, or that Sentinel operates behind an "information barrier." I just want to say "remind me to call Mom on Saturday" and have it work.

The document itself admits the naming is a metaphor -- "navigation and cartography." That is cute for developers. For me, it is six new vocabulary words I have to learn before I can use my own assistant. Siri has zero vocabulary words. Google Assistant has zero. Even ChatGPT has zero -- I just type or talk.

**The concern**: If the user interface (Bridge, I guess?) is well-designed enough, maybe I never need to know about any of this. But the document does not give me confidence that is the plan. It talks about "Gear management panels," "Sentinel Memory browsers," "job queue sidebars," and "system logs." That sounds like a control room, not an assistant.

---

## 3. API Keys: The Dealbreaker Nobody Wants to Talk About

This is the part where I think the project fundamentally misunderstands its audience, or at least the audience I represent.

To use Meridian, I need to:

1. Go to a website like Anthropic, OpenAI, or Google
2. Create a **developer account**
3. Find something called an "API key"
4. Figure out billing and set up a payment method with the AI provider
5. Copy that key into Meridian's configuration

I have never created a developer account for anything. I do not know what an API key is. I would not know where to find one or what it looks like. The idea that I need to sign up for a *separate billing relationship* with an AI company, on top of running Meridian, is genuinely absurd from a normal user's perspective.

For comparison: when I set up Alexa, I logged into my Amazon account. Done. When I use Siri, it just works -- no account needed. When I signed up for ChatGPT, I made one account and picked a plan. Simple.

Meridian's setup requires me to become a customer of *two different AI companies* (one for Scout, one for Sentinel, since the document recommends different providers for security), manage two separate API keys, understand billing for both, and configure everything in a TOML file (I do not know what TOML is).

The document mentions "Ollama" for running local models, which would avoid the API key problem. But then I need to install *another piece of software*, download AI models, and hope my hardware can run them. The document targets a Raspberry Pi with 4-8 GB of RAM. I do not think a local AI model runs well on that.

**This single issue -- the API key requirement -- will stop more people from using Meridian than every other problem combined.**

---

## 4. Approval Fatigue: The World's Most Demanding Secretary

Let me walk through what happens when I say "email John about dinner Friday":

1. Scout (the planner) creates an "execution plan" with multiple "steps"
2. Sentinel (the safety validator) reviews each step against five categories: security, privacy, financial, ethical, and legal
3. According to the default policies, "Sending messages (email, chat)" requires user approval
4. So Sentinel returns "NEEDS_USER_APPROVAL"
5. Meridian sends me an approval request through the UI
6. I have to open the UI and approve it
7. Only *then* does it actually send the email

I asked for **one thing** -- send an email -- and I got interrupted at least once with a permission dialog. If the email involves a network POST request (it does), that is another approval according to the default policies. If it needs to access my email credentials, that is logged and potentially another checkpoint.

This is not an assistant. This is a paranoid bureaucrat.

I understand *why* the approval system exists -- the document spends a lot of time talking about another project (OpenClaw) that apparently went badly wrong because it did things without checking. Security is important. But there is a massive gap between "no safety checks" and "approve every single action." Somewhere in that gap is where an actual usable assistant lives.

The document mentions "Sentinel Memory" which can remember my approval decisions and auto-approve similar actions in the future. That sounds promising! But it means the first week (or month) of using Meridian will be an endless parade of "Can I do this? Can I do that? Can I send this email? Can I search the web? Can I save this file?" Before it learns enough to leave me alone, I will have already gone back to Siri out of pure frustration.

**What I want**: Smart defaults. If I ask you to email someone, just email them. If you are about to delete all my files, then yeah, ask me. But treat me like a competent adult, not like someone who needs to sign a waiver every time I want to Google something.

---

## 5. How Much Will This Cost Me? (Nobody Knows)

The document mentions:
- "Daily cost limits" (default $5/day)
- "Per-job token limits"
- "Adaptive model selection can reduce API costs by 30-50%"
- "Running two LLM calls per task approximately doubles per-task API costs"

But it never says what normal usage actually costs. Not even a ballpark.

Let me try to piece it together. Every time I ask Meridian to *do something* (not just chat), it makes at least two AI API calls -- one for Scout (the planner) and one for Sentinel (the safety checker). If it also reflects on the task afterward with Journal, that is a third call. If it needed to search its memory first, that might involve embeddings, which could be a fourth.

So a single "send an email" request could be 3-4 API calls. If I use Meridian 20 times a day for real tasks, that is 60-80 API calls. At current Claude or GPT-4 pricing, I have no idea what that costs, but the document helpfully sets the default daily limit at $5, which suggests the developers expect it could easily cost more than that.

$5/day is $150/month. ChatGPT Pro is $20/month. Claude Pro is $20/month. Both of those give me unlimited conversation, and I do not have to run a server or manage API keys.

Even if real-world costs are lower -- say $1-2/day for moderate use -- that is $30-60/month for something that requires dramatically more effort to set up and maintain. The value proposition makes no sense from a cost perspective unless privacy is worth that premium to me (and I will get to the privacy issue later).

**What I need**: An honest cost calculator. "If you use Meridian for X tasks per day, expect to pay approximately $Y per month in API costs." Right now I am flying completely blind.

---

## 6. What Can It Actually Do? (Not Much)

The built-in capabilities ("Gear") that ship with Meridian are:

| Gear | What It Does |
|------|-------------|
| file-manager | Manage files in a workspace folder |
| web-search | Search the web |
| web-fetch | Fetch web pages |
| shell | Run computer commands (requires approval every time) |
| scheduler | Set up recurring tasks |
| notification | Send me notifications |

That is it. Out of the box, Meridian cannot:
- Send or read email
- Manage my calendar
- Control smart home devices
- Play music
- Make phone calls
- Set timers or alarms (on my phone)
- Shop online
- Check the weather (without a web search)
- Interact with any of my apps

The document's idea page talks about "managing calendars, drafting emails, automating smart home devices, building software projects." But none of that is included. To get any of it, I need to either:

1. Install additional Gear (from where? the registry does not exist yet)
2. Wait for Journal to magically "learn" how to do things and create its own Gear (this sounds genuinely like science fiction)
3. Build it myself (I cannot code)

So what I am actually getting out of the box is a very expensive web search tool and a file manager with an AI chatbot bolted on. I already have a web browser and a file manager. Why would I go through all the trouble of setting up Meridian for this?

The idea that Journal will "learn" to build new capabilities over time is the most exciting part of the whole document. But it is also the part I trust the least. The system is supposed to notice patterns in my requests, realize it needs a new plugin, write the code for that plugin, test it, and present it to me for review. That sounds amazing. It also sounds like it is years away from working reliably, if it ever does.

---

## 7. The Privacy Promise Has a Giant Asterisk

The document's privacy pitch is: "All your data stays on your device."

But wait. Every single task I give Meridian gets sent to Anthropic, OpenAI, or Google's servers as an API call. The document even says the audit log records "the exact content sent" to these APIs -- which means a lot of my data IS being sent externally.

So when they say "your data stays on your device," what they really mean is "your data is *stored* on your device, but it is also sent to AI companies for processing every time you use it."

How is that more private than just using ChatGPT directly? With ChatGPT, my data also goes to an AI company. The difference is that with ChatGPT, I do not have to run a server.

The document mentions "minimum context principle" -- only the data needed for the current task is sent. That is better than sending everything, I suppose. And it mentions that you can run local AI models through Ollama for "fully offline, zero-data-sharing operation." But as I mentioned earlier, local models on a Raspberry Pi sounds like a fantasy, and running capable local models on any hardware requires expensive equipment and technical expertise.

For the realistic scenario -- using cloud AI providers -- the privacy benefit boils down to: "We store your conversation history locally instead of on ChatGPT's servers, but we still send your requests to an AI company." That is a marginal improvement, not the revolutionary privacy story the document is selling.

**To be fair**: There is a real privacy benefit in that Meridian does not have its own data collection. There is no company behind Meridian harvesting my usage data for ad targeting or model training. My data sits on my device and I control it. That matters. But the document oversells this when the AI companies on the other end of those API calls may very well be retaining my data according to their own policies.

---

## 8. Voice Interaction: An Afterthought

I talk to Siri dozens of times a day while cooking, driving, and walking. Voice is not a feature -- it is the primary way I interact with an assistant.

Meridian's voice support is described in one line of a table:

> Voice: Web Speech API for recording, Whisper API (or local whisper.cpp) for transcription

That is it. One line. In a 2,000+ line document. Voice is mentioned as an "input modality" alongside text, images, and video. There is no mention of:

- Wake words ("Hey Meridian")
- Always-listening mode
- Speaker output (text-to-speech responses)
- Hands-free operation
- Mobile app with voice support
- Integration with home speakers

The entire interface is a web page ("Bridge"). To use Meridian with voice, I would apparently need to have my browser open, navigate to the page, click a microphone button, speak, and then read the response on screen. That is not voice interaction. That is dictation with extra steps.

If I cannot talk to Meridian while my hands are covered in flour, while I am driving, or from across the room, it is not a personal assistant in the way I understand the term. It is a chatbot with a web interface.

---

## 9. Can I Actually Depend on This?

The architecture document includes a "Graceful Degradation" table that describes what happens when things go wrong:

- "Scout's LLM API is unreachable" -- retry, notify user, fall back to local model
- "Sentinel's LLM API is unreachable" -- queue everything, do not execute anything, notify user
- "Both APIs unreachable" -- system enters "offline mode," queues jobs but cannot do anything
- "Journal database corrupted" -- continue without memory
- "Gear sandbox fails to start" -- skip the failing plugin, report error
- "Disk full" -- pause everything

From an engineering standpoint, this is responsible design. From a user standpoint, this is terrifying. It is a long list of ways my assistant might not work when I need it.

When I tell Siri to set a timer, it works. Every time. Instantly. Even without internet (for basic tasks). There is no queue, no retry, no degraded state. It just works.

Meridian depends on external AI services being available, my home device being running, my internet connection being stable, multiple databases being uncorrupted, and sandboxes working correctly. Any one of those failing means my assistant either cannot do what I asked or enters some kind of limping mode where it queues my request and hopes things get better.

I am not asking for perfection. But "set a reminder" should not depend on an API call to a company in San Francisco, routed through a safety validator that uses a different API call to a company in another city, only to put an entry in a local database. That is a Rube Goldberg machine for a task my phone handles in milliseconds.

---

## 10. The Self-Hosting Tax: I Did Not Sign Up to Be an IT Department

The document targets "Raspberry Pi, Mac Mini, VPS" as deployment environments. Let me describe what self-hosting actually means for someone like me:

- I need to buy and set up hardware (or rent a VPS, which I do not know how to do)
- I need to install and configure software using a terminal
- I need to keep the system updated (the document says updates are manual -- "the user must explicitly trigger both the check and the update")
- I need to manage backups (automated daily, but I need to set up where they go)
- I need to handle security (the document mentions TLS certificates, reverse proxies, DNS rebinding attacks -- words I do not understand)
- I need to deal with database migrations when I update
- I need to monitor disk space, memory usage, and system health
- If something breaks, I need to debug it using "job inspectors," "replay mode," and "dry runs"

This is not a personal assistant. This is a personal server administration hobby. I already have a full-time job. I do not want another one that involves monitoring Prometheus metrics and checking SQLite integrity.

The document mentions a "setup wizard" for first-run authentication. Great start. But that is the only mention of guided setup in the entire 2,077 lines. Everything else assumes I am comfortable with configuration files, command-line tools, and Docker.

---

## 11. Why Not Just Pay $20/Month for ChatGPT or Claude?

Let me lay out the comparison honestly:

| | ChatGPT Pro ($20/mo) | Claude Pro ($20/mo) | Meridian (self-hosted) |
|---|---|---|---|
| Setup time | 2 minutes | 2 minutes | Hours to days (if I can figure it out at all) |
| Technical skill needed | None | None | Significant |
| Works on my phone | Yes (app) | Yes (app) | Unclear -- web-only, no mobile app mentioned |
| Voice interaction | Yes | Limited | Barely |
| Runs when I travel | Yes | Yes | Only if my home server stays on |
| Updates | Automatic | Automatic | Manual |
| Monthly cost | $20 flat | $20 flat | $30-150+ in API fees, plus electricity, plus my time |
| Can send emails | Via plugins/GPTs | No | Not without extra Gear I cannot build |
| Can control smart home | Via plugins | No | Not out of the box |
| Learns my preferences | Somewhat | Somewhat | Yes, in theory -- this is the big differentiator |
| My data stays local | No | No | Partially (stored locally, but sent to APIs) |
| Runs if internet is down | No | No | Barely |

The only areas where Meridian clearly wins are "data stored locally" and "learns and improves over time." The learning part is the genuinely compelling feature -- the idea that Meridian gets better the more I use it, builds custom tools for my specific needs, and becomes uniquely mine. That is something ChatGPT and Claude do not really do.

But is that worth the enormous difference in setup effort, ongoing maintenance, cost, and limited out-of-the-box functionality? For me, right now, honestly? No.

---

## What Would Change My Mind

I am not saying Meridian is a bad idea. The *idea* is genuinely great. An AI assistant that lives on my own device, learns my habits, builds new skills over time, and keeps me in control? I want that future. Here is what would need to happen for me to actually use it:

1. **One-click installer**: Download, double-click, follow a wizard. No terminal, no Docker, no YAML.

2. **Built-in AI**: Either partner with an AI provider for a subscription plan ("Meridian Pro: $25/month, AI included"), or make local models actually work out of the box on reasonable hardware. The API key dance is a non-starter for regular people.

3. **Actually useful on day one**: Ship with email, calendar, reminders, weather, and basic smart home control. The "thin platform" philosophy is clever engineering, but it means I get almost nothing useful at first.

4. **Smart approval defaults**: Trust me to send emails and search the web without asking permission. Only interrupt me for genuinely dangerous things like deleting files or spending money. And learn quickly from my first few approvals.

5. **Real voice support**: Wake word, always-listening option, spoken responses, works from across the room. If I have to open a browser to use my assistant, it is not an assistant.

6. **A mobile app**: I use my phone more than any other device. Meridian needs to be on my phone.

7. **Clear pricing**: Tell me upfront what it will cost. "$2-5/month for light use, $10-20/month for heavy use, here is how to estimate." Do not make me figure it out from token counts and API pricing pages.

8. **Invisible maintenance**: Auto-update (with my permission at a scheduled time, like my phone does). Auto-backup to iCloud or Google Drive. Monitor its own health and tell me if something needs attention in plain English, not log files.

---

## Final Thoughts

Meridian is currently a project built by engineers, for engineers. The architecture is impressive -- the security model, the dual-LLM validation, the learning system, the plugin architecture. As a technical document, it is thorough and thoughtful.

But as a product for people like me, it does not exist yet. Between the installation barrier, the API key requirement, the limited out-of-the-box functionality, the approval fatigue, the unclear costs, the minimal voice support, and the ongoing maintenance burden, there is no realistic path from "normal person who wants a better Siri" to "happy Meridian user."

The vision is right. A private, learning, capable AI assistant is something millions of people would pay for. But the path to that vision runs through a lot of product decisions that this architecture document has not made yet -- or has made in a way that prioritizes engineering elegance over user experience.

I hope the team reads this and realizes that the hardest problem is not the architecture. The architecture seems solid. The hardest problem is making all of this invisible to someone like me.
