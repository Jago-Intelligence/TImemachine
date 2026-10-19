"""Render the architecture SVG as a deterministic notebook-style illustration.
Requires Pillow; uses macOS handwriting fonts (override paths for other systems).
All positions, text and arrows are sourced from the architecture SVG.
"""
import math
import os
import random
import re
import xml.etree.ElementTree as ET
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'docs/media/timemachine-architecture.svg'
OUTPUT = ROOT / 'docs/media/timemachine-architecture-sketch.png'
S = 2
random.seed(17)
image = Image.new('RGB', (1600*S, 1120*S), '#fffef7')
draw = ImageDraw.Draw(image)
regular = os.environ.get('TM_SKETCH_FONT', '/System/Library/Fonts/Noteworthy.ttc')
bold = os.environ.get('TM_SKETCH_BOLD_FONT', '/System/Library/Fonts/Supplemental/Bradley Hand Bold.ttf')
fonts = {}

def xy(point): return tuple(round(value*S) for value in point)
def line(a,b,color='#55574e',width=1.2,dashed=False):
    distance = math.dist(a,b)
    if not distance: return
    segments = max(2, int(distance/8))
    points = []
    for i in range(segments+1):
        t=i/segments
        jitter=0 if i in (0,segments) else random.uniform(-.8,.8)
        points.append(((a[0]+(b[0]-a[0])*t+jitter)*S,(a[1]+(b[1]-a[1])*t+jitter)*S))
    if dashed:
        for i in range(0,len(points)-1,2):draw.line(points[i:i+2],fill=color,width=max(1,round(width*S)))
    else:draw.line(points,fill=color,width=max(1,round(width*S)))

def arrow(a,b):
    angle=math.atan2(b[1]-a[1],b[0]-a[0])
    for delta in [-.55,.55]:
        p=(b[0]-11*math.cos(angle+delta),b[1]-11*math.sin(angle+delta))
        line(p,b,'#42654f',1.7)

# Quiet notebook ruling and a pencil margin.
for y in range(22,1120,32):draw.line((0,y*S,1600*S,y*S),fill='#e8eef1',width=1)
draw.line((25*S,0,25*S,1120*S),fill='#ead0ca',width=2)
root=ET.parse(SOURCE).getroot()
rectangles=[]
for element in root:
    tag=element.tag.split('}')[-1]
    if tag=='rect' and 'class' in element.attrib:
        x,y,w,h=(float(element.get(k)) for k in ['x','y','width','height'])
        rectangles.append((x,y,w,h))
        cls=element.get('class')
        if cls=='green':draw.rectangle((xy((x+2,y+2)),xy((x+w-2,y+h-2))),fill='#f0f3e5')
        corners=[(x,y),(x+w,y),(x+w,y+h),(x,y+h),(x,y)]
        for a,b in zip(corners,corners[1:]):line(a,b,'#899088' if cls=='boundary' else '#545d52',1.0,cls=='boundary')
        if cls!='boundary':
            for a,b in zip(corners,corners[1:]):line((a[0]+1.5,a[1]+1),(b[0]+1.5,b[1]+1),'#a1a598',.4)
    elif tag=='path' and 'class' in element.attrib:
        tokens=re.findall(r'[MHVL]|-?\d+(?:\.\d+)?',element.get('d'))
        points=[];i=0;x=y=0
        while i<len(tokens):
            command=tokens[i];i+=1
            if command in ('M','L'):x=float(tokens[i]);y=float(tokens[i+1]);i+=2
            elif command=='H':x=float(tokens[i]);i+=1
            elif command=='V':y=float(tokens[i]);i+=1
            points.append((x,y))
        for a,b in zip(points,points[1:]):line(a,b,'#42654f',1.5,'optional' in element.get('class'))
        if len(points)>1:
            arrow(points[-2],points[-1])
            if 'both' in element.get('class'):arrow(points[1],points[0])
    elif tag=='text':
        x,y=float(element.get('x')),float(element.get('y'));cls=element.get('class');value=''.join(element.itertext()).replace('→', '->')
        size={'title':34,'heading':24,'body':19,'small':17,'label':18}.get(cls,18)
        path=bold if cls in ('title','heading') else regular
        containers=[r for r in rectangles if r[0]<x<r[0]+r[2] and r[1]<y<r[1]+r[3]]
        room=1600-x-24
        if containers:
            box=min(containers,key=lambda r:r[2]*r[3]);room=box[0]+box[2]-x-12
        f=ImageFont.truetype(path,size*S)
        while draw.textlength(value,font=f)>room*S and size>13:
            size-=1;f=ImageFont.truetype(path,size*S)
        color='#314239' if cls!='small' else '#697366'
        draw.text(xy((x,y-size*.94)),value,font=f,fill=color)
image.save(OUTPUT,optimize=True)
print(f'Created {OUTPUT.name}: {image.width} × {image.height}. Labels and connections preserved from SVG.')
