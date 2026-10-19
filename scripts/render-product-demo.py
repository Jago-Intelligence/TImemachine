"""Render an illustrative TimeMachine walkthrough. Requires Pillow and ffmpeg.
No application screenshots, credentials, backend traffic, or AI-generated assets.
"""
import os
import subprocess
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
W, H, FPS, DURATION = 1280, 720, 24, 44
INK, MUTED, GREEN, LINE = '#17251d', '#6e7972', '#246344', '#e2e8e3'
RED, SOFT, ERROR = '#b94435', '#eff6f0', '#fff1ed'
FONT_ROOT = Path('/System/Library/Fonts/Supplemental')
FONT_NORMAL = os.environ.get('TM_VIDEO_FONT', str(FONT_ROOT / 'Arial.ttf'))
FONT_BOLD = os.environ.get('TM_VIDEO_BOLD_FONT', str(FONT_ROOT / 'Arial Bold.ttf'))
FONT_MONO = os.environ.get('TM_VIDEO_MONO_FONT', '/System/Library/Fonts/Menlo.ttc')
fonts = {}

def font(size, bold=False, mono=False):
    key = (size, bold, mono)
    if key not in fonts:
        path = FONT_MONO if mono else FONT_BOLD if bold else FONT_NORMAL
        fonts[key] = ImageFont.truetype(path, size)
    return fonts[key]

def ease(value):
    value = max(0, min(1, value))
    return 1 - (1-value)**3

def text(draw, x, y, value, size=22, color=INK, bold=False, mono=False):
    draw.text((x, y), value, font=font(size, bold, mono), fill=color)

def card(draw, box, fill='white', outline=LINE):
    draw.rounded_rectangle(box, radius=8, fill=fill, outline=outline, width=1)

def badge(draw, x, y, value, good=True):
    size=16
    width=draw.textlength(value,font=font(size,True))+26
    draw.rounded_rectangle((x,y,x+width,y+32),radius=5,fill=SOFT if good else ERROR)
    text(draw,x+13,y+7,value,size,GREEN if good else RED,True)

def logo(draw, x, y, size=38):
    # Exact path proportions from the existing TimeMachine Mark SVG.
    draw.rounded_rectangle((x,y,x+size,y+size),radius=8,fill=GREEN)
    def point(a,b):return (x+(a-70)/880*size,y+(size-size*720/880)/2+(b-150)/880*size)
    width=max(2,round(86/880*size))
    for a,b,c,d in [(128,511,895,511),(298,383,298,640),(597,213,597,811)]:
        start,end=point(a,b),point(c,d)
        draw.line((start,end),fill='white',width=width)
        for px,py in [start,end]:draw.ellipse((px-width/2,py-width/2,px+width/2,py+width/2),fill='white')

# A continuous spatial composition. The virtual camera follows the request through
# the application, captured evidence, code correction and verification.
SW, SH = 3400, 1600
KEYS = [(0, (380, 620, 1.12)), (4, (450, 620, 1.12)),
        (8, (1060, 620, 1.30)), (13, (1500, 620, 1.65)),
        (19, (2040, 600, 1.60)), (25, (2380, 640, 1.40)),
        (31, (2770, 640, 1.35)), (37, (1700, 700, .38)),
        (44, (1700, 700, .38))]

def smooth(value):
    value=max(0,min(1,value)); return value*value*(3-2*value)

def camera(t):
    for (ta,a),(tb,b) in zip(KEYS,KEYS[1:]):
        if ta <= t <= tb:
            u=smooth((t-ta)/(tb-ta))
            return tuple(x+(y-x)*u for x,y in zip(a,b))
    return KEYS[-1][1]

def node(draw,x,y,width,height,title,subtitle):
    card(draw,(x,y,x+width,y+height),outline=LINE)
    text(draw,x+24,y+22,title,26,bold=True)
    text(draw,x+24,y+65,subtitle,16,MUTED)

def world(t):
    im=Image.new('RGB',(SW,SH),'white');d=ImageDraw.Draw(im)
    # Shared connector stays in world space, so the camera discovers the flow.
    d.line((260,740,2980,740), fill=LINE,width=3)
    for x in [450,1050,1500,2030,2400,2810]:
        d.line((x,710,x,740), fill=LINE,width=2)
        d.ellipse((x-5,735,x+5,745),fill=GREEN)
    logo(d,130,410,42);text(d,188,414,'TimeMachine',30,bold=True)
    text(d,130,475,'Every failure has a story.',38,bold=True)
    node(d,130,555,550,155,'POST /api/convert','Your Express backend · amount: 100')
    text(d,154,662,'A normal request. An unexpected failure.',20,MUTED)
    node(d,820,455,410,255,'Currency API','The pricing service returned a usable rate.')
    text(d,844,559,'{ "rate": 0.9,',23,mono=True)
    text(d,844,598,'  "currency": "EUR" }',23,mono=True)
    if t>5:badge(d,844,648,'HTTP 500 · TypeError',False)
    # Request travels along the path, then the camera overtakes it.
    x=220+900*smooth(t/7)
    if t<8:
        d.ellipse((x-11,729,x+11,751),fill=GREEN if t<5 else RED)
        d.ellipse((x-17,723,x+17,757),outline=GREEN if t<5 else RED,width=2)
    node(d,1300,405,445,305,'Captured evidence','Request + dependency + source location')
    text(d,1324,510,'POST /api/convert',23,bold=True)
    text(d,1324,556,'amount: 100',21,mono=True)
    text(d,1324,598,'rate: 0.9',21,GREEN,mono=True)
    text(d,1324,640,'src/app.js:37:44',20,RED,mono=True)
    node(d,1810,360,545,350,'One field. One broken assumption.','The app reads a field the response never returned.')
    text(d,1834,468,'pricing.ratePerUnit.toFixed(2)',22,RED,mono=True)
    d.line((1834,501,2250,501),fill=RED,width=2)
    text(d,1834,546,'Recorded response: rate = 0.9',21,MUTED)
    if t>21:
        reveal=smooth((t-21)/2)
        d.rounded_rectangle((1834,597,2305,657),radius=5,fill=SOFT)
        value='pricing.rate.toFixed(2)'
        text(d,1850,615,value[:int(len(value)*reveal)],22,GREEN,mono=True)
    node(d,2420,455,340,255,'Isolated replay','Same saved inputs. Controlled dependencies.')
    text(d,2444,551,'Captured build',20)
    badge(d,2444,586,'HTTP 500',False)
    node(d,2830,405,420,305,'Verify the changed code','A developer-written fix, tested in isolation.')
    if t>27:
        badge(d,2854,505,'HTTP 200 · assertions passed')
        text(d,2854,563,'100 × 0.9 = 90 EUR',25,GREEN,True)
        text(d,2854,612,'Same scenario. Expected result.',19,MUTED)
    if t>35:
        text(d,890,900,'Capture the failure. Reproduce it. Verify the fix.',66,GREEN,True)
        text(d,1090,1010,'Open source · Self hosted · Express',36,MUTED)
        text(d,890,1120,'Keep historical builds. Share evidence. Alert your team.',36,MUTED)
    return im

OUTPUT=ROOT/'docs/media/timemachine-product-demo.mp4'
OUTPUT.parent.mkdir(parents=True,exist_ok=True)
command=['ffmpeg','-y','-loglevel','error','-f','rawvideo','-pix_fmt','rgb24','-s',f'{W}x{H}','-r',str(FPS),'-i','-','-an','-c:v','libx264','-preset','fast','-crf','19','-pix_fmt','yuv420p','-movflags','+faststart',str(OUTPUT)]
process=subprocess.Popen(command,stdin=subprocess.PIPE)
try:
    for frame in range(FPS*DURATION):
        t=frame/FPS;cx,cy,zoom=camera(t)
        halfw=W/(2*zoom);halfh=H/(2*zoom)
        image=world(t).transform((W,H),Image.Transform.EXTENT,(cx-halfw,cy-halfh,cx+halfw,cy+halfh),Image.Resampling.BICUBIC,fillcolor='white')
        overlay=ImageDraw.Draw(image)
        text(overlay,36,686,'Illustrative animation · synthetic data · not a live screen recording',12,MUTED)
        if t<3.5:
            text(overlay,36,36,'Follow one failed request.',20,GREEN,True)
        process.stdin.write(image.tobytes())
        if frame%(FPS*8)==0: print(f'Rendering camera sequence: {int(t)}s / {DURATION}s',flush=True)
    process.stdin.close()
    if process.wait()!=0:raise RuntimeError('Video encoding failed')
except BaseException:
    process.kill();process.wait();raise
print(f'Created {OUTPUT.name}: {DURATION}s, {W}×{H}, {OUTPUT.stat().st_size/1048576:.1f} MB')
