"""Editable, millimetre Flex module assets from official envelopes and photographs.

Run: Blender --background --python blender/build_flex_modules.py
Append -- export-only to rebuild files without renders, or -- <model> to render one.
Photo-derived details are illustrative, not manufacturing CAD. No protocol code.
"""
import json
import math
import sys
from collections import defaultdict
from pathlib import Path

import bpy
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'cad/flex/modules/detailed'
PREVIEW = ROOT / 'exports/flex-modules'
OUT.mkdir(parents=True, exist_ok=True)
PREVIEW.mkdir(parents=True, exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
SCENE = bpy.context.scene
SCENE.unit_settings.system = 'METRIC'
SCENE.unit_settings.scale_length = .001
SCENE.unit_settings.length_unit = 'MILLIMETERS'
SCENE.render.engine = 'CYCLES'
SCENE.cycles.samples = 48
SCENE.cycles.use_denoising = True
SCENE.render.resolution_x = 1200
SCENE.render.resolution_y = 1000
SCENE.render.resolution_percentage = 100
SCENE.world = bpy.data.worlds.new('Soft grey studio')
SCENE.world.use_nodes = True
SCENE.world.node_tree.nodes['Background'].inputs[0].default_value = (.26, .29, .34, 1)
SCENE.world.node_tree.nodes['Background'].inputs[1].default_value = .55
SCENE.view_settings.view_transform = 'AgX'

COLORS = {
    'aluminium': (.56, .60, .64, 1), 'edge': (.30, .34, .38, 1),
    'black': (.025, .031, .037, 1), 'rubber': (.012, .016, .019, 1),
    'well': (.105, .13, .15, 1), 'steel': (.67, .70, .73, 1),
    'white': (.83, .87, .89, 1), 'blue': (.06, .38, .72, 1),
    'cyan': (.16, .69, .84, 1), 'heated_pad': (.36, .12, .065, 1),
    'amber': (.92, .48, .05, 1),
}
MATERIALS = {}
for name, rgba in COLORS.items():
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = rgba
    mat.use_nodes = True
    node = mat.node_tree.nodes.get('Principled BSDF')
    node.inputs['Base Color'].default_value = rgba
    node.inputs['Roughness'].default_value = .3 if name in ('steel', 'aluminium') else .55
    node.inputs['Metallic'].default_value = .7 if name in ('steel', 'aluminium', 'edge') else .05
    if name in ('black', 'rubber', 'well'):
        node.inputs['Specular IOR Level'].default_value = .12
    if name in ('cyan', 'blue'):
        node.inputs['Emission Color'].default_value = rgba
        node.inputs['Emission Strength'].default_value = .4
    MATERIALS[name] = mat

ASSETS = {}
CURRENT = None
PARENT = None


def root(name, xyz=(0, 0, 0), parent=None):
    obj = bpy.data.objects.new(name, None)
    SCENE.collection.objects.link(obj)
    obj.parent = parent
    obj.location = xyz
    return obj


def finish(obj, name, material, bevel=0):
    obj.name = name
    obj.parent = PARENT
    obj.data.materials.append(MATERIALS[material])
    obj['component'] = name
    obj['source_basis'] = 'official envelope; photo-derived detail'
    if bevel:
        mod = obj.modifiers.new('Manufactured edge radius', 'BEVEL')
        mod.width = bevel
        mod.segments = 3
        mod.affect = 'EDGES'
        mod = obj.modifiers.new('Panel normals', 'WEIGHTED_NORMAL')
        mod.keep_sharp = True
    return obj


def box(name, p, s, material='aluminium', bevel=.6):
    bpy.ops.mesh.primitive_cube_add(size=1, location=p)
    obj = bpy.context.object
    obj.dimensions = s
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return finish(obj, name, material, min(bevel, min(s) * .22))


def cylinder(name, p, radius, depth, material='steel', axis='Z', vertices=24):
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=depth, location=p)
    obj = bpy.context.object
    if axis == 'X': obj.rotation_euler[1] = math.pi / 2
    if axis == 'Y': obj.rotation_euler[0] = math.pi / 2
    for f in obj.data.polygons: f.use_smooth = len(f.vertices) == 4
    return finish(obj, name, material, min(.25, depth / 8))


def text(name, content, p, size=4, material='white', front=False):
    curve = bpy.data.curves.new(name, 'FONT')
    curve.body = content
    curve.size = size
    curve.extrude = .025
    curve.align_x = 'CENTER'
    curve.align_y = 'CENTER'
    obj = bpy.data.objects.new(name, curve)
    SCENE.collection.objects.link(obj)
    obj.location = p
    if front: obj.rotation_euler[0] = math.pi / 2
    obj.parent = PARENT
    obj.data.materials.append(MATERIALS[material])
    return obj


def screws(xys, z, prefix='fastener'):
    for i, (x, y) in enumerate(xys):
        cylinder(f'{prefix}_{i}', (x, y, z), 1.65, .6, 'steel')
        box(f'{prefix}_slot_{i}', (x, y, z + .33), (1.65, .35, .1), 'black', .04)


def vents(x0, y, z0, count=18, width=3, height=25, step=5, side=False):
    for i in range(count):
        if side:
            box(f'vent_{i}', (x0, y+i*step, z0), (.22, width, height), 'black', .08)
        else:
            box(f'vent_{i}', (x0+i*step, y, z0), (width, .22, height), 'black', .08)


def ports(x, y, z):
    cylinder('power_bezel', (x, y-.35, z), 5.2, 1.2, 'steel', 'Y')
    cylinder('power_button', (x, y-1.1, z), 4.05, .7, 'black', 'Y')
    text('power_mark', 'I', (x, y-1.51, z), 3.2, 'white', True)
    box('usb_frame', (x+17, y-.3, z), (8.2, 1.1, 5), 'steel', .4)
    box('usb_socket', (x+17, y-.95, z), (6.8, .3, 3.3), 'black', .25)
    box('usb_insert', (x+17, y-1.13, z+.3), (5.2, .15, 1.1), 'white', .1)
    cylinder('dc_bezel', (x+32, y-.4, z), 3.8, 1, 'steel', 'Y')
    cylinder('dc_socket', (x+32, y-1, z), 2.8, .35, 'black', 'Y')
    cylinder('dc_pin', (x+32, y-1.25, z), .65, .4, 'steel', 'Y', 12)


def well_block(name, origin, size=(127.76, 85.48), depth=9, rings=False):
    """Actual recessed holes, rather than dark dots pasted on a solid slab."""
    x0, y0, z = origin
    sx, sy = size
    # Fill margins, then tile 9 mm cells around each open well.
    gridx, gridy = x0 + (sx-108)/2, y0 + (sy-72)/2
    box(name+'_floor', (x0+sx/2, y0+sy/2, z-depth-.6), (sx, sy, 1.2), 'aluminium', .25)
    for p, s in [((x0+(gridx-x0)/2,y0+sy/2,z-depth/2), (gridx-x0,sy,depth)),
                 ((gridx+108+(x0+sx-gridx-108)/2,y0+sy/2,z-depth/2),(x0+sx-gridx-108,sy,depth)),
                 ((gridx+54,y0+(gridy-y0)/2,z-depth/2),(108,gridy-y0,depth)),
                 ((gridx+54,gridy+72+(y0+sy-gridy-72)/2,z-depth/2),(108,y0+sy-gridy-72,depth))]:
        box(name+'_border',p,s,'aluminium',.3)
    verts, faces = [], []
    radius = 3.25 if rings else 2.85
    for col in range(12):
        for row in range(8):
            cx, cy = gridx+4.5+col*9, gridy+4.5+row*9
            start = len(verts)
            for layer in range(3):
                for i in range(24):
                    angle = 2*math.pi*i/24
                    c, s = math.cos(angle), math.sin(angle)
                    if layer == 0:
                        t = 4.5 / max(abs(c),abs(s)); zz=z; rr=t
                    else: rr = radius if layer == 1 else radius*.68; zz = z if layer == 1 else z-depth
                    verts.append((cx+c*rr,cy+s*rr,zz))
            for layer in range(2):
                for i in range(24):
                    a=start+layer*24+i; b=start+layer*24+(i+1)%24
                    faces.append((a,b,b+24,a+24))
            cylinder(name+'_dark_bottom', (cx,cy,z-depth+.12), radius*.68,.25,'well',vertices=16)
            if rings:
                # Recessed ring magnet, independently readable in a close view.
                cylinder(name+'_magnet_core',(cx,cy,z-1.2),1.55,1.0,'steel',vertices=16)
    mesh=bpy.data.meshes.new(name);mesh.from_pydata(verts,[],faces);mesh.update()
    obj=bpy.data.objects.new(name,mesh);SCENE.collection.objects.link(obj)
    finish(obj,name,'black' if rings else 'aluminium')
    for col in range(12): text('column',str(col+1),(gridx+4.5+col*9,y0+sy-2,z+.15),2.3,'white' if rings else 'edge')
    for row in range(8): text('row',chr(65+row),(x0+3,gridy+67.5-row*9,z+.15),2.3,'white' if rings else 'edge')


def begin(model, dimensions, interface, label):
    global CURRENT, PARENT
    CURRENT=root(model)
    CURRENT['units']='mm'
    CURRENT['interface_origin_mm']=interface
    PARENT=CURRENT
    ASSETS[model]={'root':CURRENT,'dimensions_mm':dimensions,'interface_origin_mm':interface,
                   'label':label,'groups':{},'joints':[]}


def group(name, pivot, joint=None):
    global PARENT
    PARENT=root(name,pivot,CURRENT)
    if joint:
        ASSETS[CURRENT.name]['joints'].append({'name':name,**joint,'pivot_mm':list(pivot)})
        for k,v in joint.items():PARENT[k]=v
    ASSETS[CURRENT.name]['groups'][name]=PARENT
    return PARENT


def build_tc():
    begin('thermocyclerModuleV2',[172,245.2,170.66],[22.125,68.8,108.96],'Thermocycler GEN2')
    group('base',(0,0,0))
    box('lower_shell',(86,122.6,29),(172,245.2,58),'aluminium',5)
    box('foot_ring',(86,122.6,3),(168,240,6),'black',2)
    box('front_panel',(86,1.8,42),(162,3.6,70),'black',3)
    box('upper_chassis',(86,121,78),(169,238,46),'black',4)
    for x in (2.5,169.5):
        box('side_cheek',(x,123,70),(5,238,76),'aluminium',2)
    vents(-.05,38,59,27,3,35,5.6,True)
    vents(172.05,38,59,27,3,35,5.6,True)
    box('front_light_recess',(70,-.3,61),(112,1.1,4.8),'rubber',1)
    box('front_status_light',(70,-.95,61),(105,.5,2),'white',.3)
    cylinder('front_button',(143,-.8,61),5.6,1.6,'edge','Y')
    cylinder('front_button_face',(143,-1.7,61),3.9,.5,'black','Y')
    text('brand','OPENTRONS',(86,-.3,32),9,'white',True)
    text('model_label','THERMOCYCLER  GEN2',(86,-.35,18),4,'white',True)
    box('block_recess',(86,111.54,99),(142,101,15),'rubber',3)
    well_block('thermal_96_well_block',(22.125,68.8,108.96))
    box('rear_hinge_shroud',(86,223,105),(160,40,21),'black',4)
    for x in (24,148):
        cylinder('hinge_barrel',(x,208,117),9,24,'edge','X')
    screws([(10,55),(162,55),(10,195),(162,195)],100)
    lid=group('lid',(86,208,117),{'type':'hinge','axis':[1,0,0],'closed':0,'open':-105,'unit':'degree'})
    box('lid_shell',(0,-100,25.7),(164,196,51.4),'aluminium',5)
    box('lid_top',(0,-100,51),(155,188,4),'black',4)
    box('lid_inner_gasket',(0,-96,-1),(141,101,4),'rubber',3)
    box('heated_pressure_pad',(0,-96,-4),(124,81,3),'heated_pad',2)
    for x in (-59,59): box('lid_latch_tab',(x,-194,-6),(13,9,13),'black',1)
    for x in (-75,75):
        box('lid_edge_rail',(x,-100,30),(3,181,24),'steel',1)
    text('lid_brand','opentrons',(0,-100,53.2),9,'white')
    warning = text('lid_warning','HOT SURFACE',(0,-96,-5.55),4,'white')
    # Text on underside faces down in the closed pose.
    warning.rotation_euler[0] = math.pi


def build_hs():
    begin('heaterShakerModuleV1',[156.25,91.75,82],[17.875,2.925,68.275],'Heater-Shaker GEN1')
    group('base',(0,0,0))
    box('chassis',(78.125,45.875,29.5),(156.25,91.75,59),'aluminium',3)
    box('bottom_gasket',(78.125,45.875,4),(152,88,8),'black',2)
    box('front_panel',(78.125,1.6,29),(151,3.2,49),'black',2)
    ports(24,-.1,23)
    vents(88,-.1,28,12,2,27,4.2)
    text('model_label','HEATER-SHAKER',(78,-.3,46),4,'white',True)
    box('isolation_gap',(81.875,45.925,59.8),(132,88,2.5),'rubber',1)
    group('platform',(81.875,45.925,62))
    box('moving_top',(0,0,2),(128,86,4),'black',2)
    box('thermal_surface',(0,0,5.45),(119,77,3.65),'aluminium',1)
    screws([(-56,-34),(56,-34),(-56,34),(56,34)],7.5)
    for name, y, sign in [('latch_front',-39,-1),('latch_back',39,1)]:
        group(name,(81.875,45.925+y,69),{'type':'slide','axis':[0,sign,0],'closed':0,'open':7,'unit':'mm'})
        box('clamp_rail',(0,0,6),(128,8,12),'black',1)
        box('clamp_inner_lip',(0,-sign*3.8,9),(112,2.2,6),'rubber',.4)
        for x in (-49,49):
            box('latch_arm',(x,sign*1.6,.5),(7,4,15),'steel',.8)
            cylinder('latch_pivot',(x,sign*4,0),2.4,3,'edge','Y')
    group('base_detail',(0,0,0))
    for x in (6,150):screws([(x,8),(x,84)],58.8)


def build_temp():
    begin('temperatureModuleV2',[196,91,84],[67.05,1.65,80.09],'Temperature GEN2')
    group('base',(0,0,0))
    box('chassis',(98,45.5,39),(196,91,78),'aluminium',3)
    box('bottom_gasket',(98,45.5,3),(192,87,6),'black',1)
    box('front_panel',(98,1.5,37),(191,3,66),'black',2)
    ports(22,-.1,24)
    vents(83,-.1,34,25,2,37,4.1)
    box('thermal_tray',(131.05,44.65,78),(129.9,88,4.18),'black',1)
    box('thermal_contact',(131.05,44.65,79.59),(124,81,1),'aluminium',.5)
    for x in (67,195):box('tray_side_lip',(x,44.65,81),(2,87,6),'black',.3)
    for y in (1.7,87.5):box('tray_end_lip',(131,y,81),(126,2,6),'black',.3)
    box('display_bezel',(35,44,79.5),(47,54,3),'black',2)
    # Segmented display has geometry, so it survives STL/OBJ workflows.
    for offset,number in [(23,'0'),(43,'4')]:
        segments={'a':(0,10,10,2),'b':(6,5,2,8),'c':(6,-5,2,8),'d':(0,-10,10,2),
                  'e':(-6,-5,2,8),'f':(-6,5,2,8),'g':(0,0,10,2)}
        for k,(dx,dy,sx,sy) in segments.items():
            lit=k in ('abcdef' if number=='0' else 'bcfg')
            box('display_segment',(offset+dx,44+dy,81.1),(sx,sy,.4),'cyan' if lit else 'edge',.3)
    cylinder('display_status',(35,23,81),1.3,.4,'blue')
    text('model_label','TEMPERATURE  GEN2',(98,-.2,62),4,'white',True)
    screws([(7,8),(7,83),(188,8),(188,83)],77)
    # Separate optional 96-well insert: never silently adds it to a bare module.
    group('block_96_optional',(67.05,1.65,80.09))
    PARENT['optional']=True
    box('block_pedestal',(64,43,7),(124,82,14),'aluminium',1)
    well_block('removable_96_well_block',(0,0,17),(128,86),10)


def build_mag():
    begin('magneticBlockV1',[136,94,45],[4.125,4.125,38],'Magnetic Block GEN1')
    group('base',(0,0,0))
    box('base_shell',(68,47,15),(136,94,30),'aluminium',2)
    box('base_foot',(68,47,2),(132,90,4),'black',1)
    box('upper_plate',(68,47,31),(132,90,8),'black',1)
    well_block('ring_magnet_array',(4.125,4.125,38),(127.75,85.75),3,True)
    for x in (3,133):
        for y in (3,91):
            box('corner_retainer',(x,y,39),(6,6,12),'black',.7)
    screws([(9,9),(127,9),(9,85),(127,85)],36)
    text('model_label','MAGNETIC BLOCK',(68,-.2,19),5,'edge',True)
    text('brand','opentrons',(68,-.21,9),3.7,'edge',True)


def build_reader():
    begin('absorbanceReaderV1',[155.3,95.5,57],[6.875,4.875,.65],'Absorbance Plate Reader')
    group('base',(0,0,0))
    # Cavity floor is the documented labware offset, .65 mm above base.
    box('bottom_plate',(77.65,47.75,.3),(155.3,95.5,.6),'aluminium',.1)
    for p,s in [((3.3,47.75,9.25),(6.6,95.5,18.5)),((151.9,47.75,9.25),(6.8,95.5,18.5)),
                ((77.65,2.4,9.25),(142,4.8,18.5)),((77.65,93,9.25),(142,5,18.5))]:
        box('reader_rim',p,s,'aluminium',1)
    # Optical apertures in the cavity floor, below the plate position.
    for c in range(12):
        for r in range(8):
            cylinder('optical_aperture',(6.875+14.38+c*9,4.875+11.24+r*9,.63),2.45,.15,'black',vertices=16)
    box('side_recess',(155.35,47,10),(.2,47,5),'black',.6)
    text('model_label','ABSORBANCE READER',(77,-.15,11),3.5,'edge',True)
    screws([(3.5,6),(151.8,6),(3.5,89),(151.8,89)],18.3)
    group('lid',(77.65,47.75,18.5),{'type':'removable','axis':[0,0,1],'closed':0,'open':110,'unit':'mm'})
    box('reader_lid',(0,0,17.25),(155.3,95.5,34.5),'aluminium',4)
    box('lid_gasket',(0,0,.6),(142,87,1.2),'rubber',1)
    box('optical_cap',(0,3,36.5),(75,69,4),'black',2)
    box('handle',(0,-49,19),(114,4.5,9),'steel',1)
    text('brand','opentrons',(0,-47.9,26),6,'edge',True)
    text('lid_label','FLEX PLATE READER',(0,-47.91,12),3.8,'edge',True)


def evaluated_mesh(obj):
    deps=bpy.context.evaluated_depsgraph_get()
    evaluated=obj.evaluated_get(deps)
    mesh=evaluated.to_mesh()
    mesh.calc_loop_triangles()
    return evaluated, mesh


def export_asset(model, asset):
    """Mesh files use mm local coordinates; manifest carries one pivot per rigid group."""
    folder=OUT/model
    (folder/'parts').mkdir(parents=True,exist_ok=True)
    parts=[]
    envelope=[]
    for name, node in asset['groups'].items():
        meshes=[o for o in node.children if o.type in ('MESH','FONT')]
        by_material=defaultdict(list)
        for o in meshes:by_material[o.data.materials[0].name].append(o)
        for material, objects in by_material.items():
            vertices=[];triangles=[]
            for obj in objects:
                ev,mesh=evaluated_mesh(obj)
                transform=node.matrix_world.inverted() @ obj.matrix_world
                offset=len(vertices)
                vertices += [tuple(transform @ v.co) for v in mesh.vertices]
                triangles += [tuple(offset+i for i in t.vertices) for t in mesh.loop_triangles]
                ev.to_mesh_clear()
            ident=f'{name}_{material}'
            objpath=folder/'parts'/f'{ident}.obj'
            with objpath.open('w') as f:
                for v in vertices:f.write('v '+' '.join(f'{x:.6f}' for x in v)+'\n')
                for t in triangles:f.write('f '+' '.join(str(i+1) for i in t)+'\n')
            # Binary STL, same local millimetre frame, deterministic and compact.
            import struct
            with (folder/'parts'/f'{ident}.stl').open('wb') as f:
                f.write(b'virtual-lab Flex module; local mm'.ljust(80,b'\0'))
                f.write(struct.pack('<I',len(triangles)))
                for t in triangles:
                    a,b,c=[Vector(vertices[i]) for i in t];n=(b-a).cross(c-a).normalized()
                    f.write(struct.pack('<12fH',*n,*a,*b,*c,0))
            parts.append({'name':ident,'group':name,'file':f'{model}/parts/{ident}.obj',
                          'stl':f'{model}/parts/{ident}.stl','rgba':list(COLORS[material]),
                          'vertices':len(vertices),'triangles':len(triangles)})
            if not node.get('optional'):
                envelope.extend([Vector(v)+node.location for v in vertices])
    result={k:v for k,v in asset.items() if k not in ('root','groups')}
    result['groups']={name:{'parent':'root','origin_mm':list(node.location),'optional':bool(node.get('optional'))}
                      for name,node in asset['groups'].items()}
    result['parts']=parts
    result['closed_bounds_mm']={
        'min':[min(v[i] for v in envelope) for i in range(3)],
        'max':[max(v[i] for v in envelope) for i in range(3)]}
    result['nominal_envelope_note']='Nominal body envelope excludes small connectors/labels; see measured closed_bounds_mm.'
    result['format_units']={'blend':'mm (scene scale_length .001)','obj':'mm, part-local','stl':'mm, part-local','glb':'m, standard glTF'}
    result['provenance']={'geometry':'project authored; official photographs and module definitions',
        'license':'Project-authored geometry; reference images retain original rights',
        'dimensions':'Official module definition envelopes and labware offsets',
        'detail':'Photo reconstruction, not metrology or manufacturer CAD',
        'motion':'Hinge and latch pivots/travel are illustrative, not calibrated',
        'docs':f'https://docs.opentrons.com/flex/modules/',
        'reference_images':'sources.json',
        'module_definition':f'../{model}.json',
        'source_definition':'https://github.com/Opentrons/opentrons/tree/edge/shared-data/module/definitions/3',
        'reader_height_basis':'Official product specification 57 mm; not bareOverallHeight + lidHeight' if model=='absorbanceReaderV1' else None,
        'nominal_size_discrepancies':'Software envelopes used for interface compatibility. Brochure L/W may differ by a few mm.'}
    # Individual editable file and interoperable GLB retain hierarchical local frames.
    bpy.ops.object.select_all(action='DESELECT')
    for obj in [asset['root']]+list(asset['root'].children_recursive):obj.select_set(True)
    # glTF specifies metres. Blender 5.2 does not apply scale_length here.
    # Scale the assembly root for export, then restore the editable mm source.
    asset['root'].scale=(.001,.001,.001)
    bpy.context.view_layer.update()
    bpy.ops.export_scene.gltf(filepath=str(folder/'model.glb'),export_format='GLB',use_selection=True,
                             export_extras=True,export_animations=False,export_apply=True)
    asset['root'].scale=(1,1,1)
    bpy.context.view_layer.update()
    return result


def aim(obj, at):obj.rotation_euler=(Vector(at)-obj.location).to_track_quat('-Z','Y').to_euler()


def render(model, state='closed', insert=False):
    asset=ASSETS[model]
    for key,item in ASSETS.items():
        for obj in item['root'].children_recursive:
            obj.hide_render=key!=model or bool(obj.parent and obj.parent.get('optional') and not insert)
    for name,node in asset['groups'].items():
        node.rotation_euler=(0,0,0)
        node.location=Vector(next((j['pivot_mm'] for j in asset['joints'] if j['name']==name),node.location))
    if state=='open':
        for j in asset['joints']:
            node=asset['groups'][j['name']]
            if j['type']=='hinge':node.rotation_euler[0]=math.radians(j['open'])
            elif j['type']=='slide':node.location+=Vector(j['axis'])*j['open']
            elif j['type']=='removable':node.location+=Vector((0,-130,0))
    meshes=[o for o in asset['root'].children_recursive if o.type in ('MESH','FONT') and not o.hide_render]
    bpy.context.view_layer.update()
    pts=[o.matrix_world@Vector(c) for o in meshes for c in o.bound_box]
    lo=Vector(tuple(min(p[i] for p in pts) for i in range(3)))
    hi=Vector(tuple(max(p[i] for p in pts) for i in range(3)))
    target=(lo+hi)/2;span=max(hi-lo)
    camera.location=target+Vector((-.95,-1.45,1.05))*span
    aim(camera,target);camera.data.type='ORTHO';camera.data.ortho_scale=span*(1.85 if state=='open' else 1.5)
    for light,offset,energy in lights:
        light.location=target+Vector(offset)*span
        light.data.energy=energy*span**2*.1
        light.data.size=span*1.4
        aim(light,target)
    floor.location=(target.x,target.y,-2);floor.scale=(span*20,span*20,1)
    SCENE.render.filepath=str(PREVIEW/f'{model}-{state}{"-insert" if insert else ""}.png')
    bpy.ops.render.render(write_still=True)


build_tc();build_hs();build_temp();build_mag();build_reader()
bpy.context.view_layer.update()
manifest={'schema':'virtual-lab.flex-modules/1','units':'mm','up':'Z','axes':'X right, Y back, Z up',
          'asset_root':'.','modules':{model:export_asset(model,a) for model,a in ASSETS.items()}}
(OUT/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')

bpy.ops.object.camera_add();camera=bpy.context.object;camera.name='Review camera';SCENE.camera=camera
camera.data.clip_end=100000
lights=[]
for name,offset,energy in [('Key',(-1,-2,3),1000),('Fill',(2,-1,2),650),('Rim',(0,2,3),1200)]:
    bpy.ops.object.light_add(type='AREA');lamp=bpy.context.object;lamp.name=name;lights.append((lamp,offset,energy))
bpy.ops.mesh.primitive_plane_add(size=1);floor=bpy.context.object;floor.name='Studio floor'
floor.data.materials.append(MATERIALS['white'])
targets=set(sys.argv[sys.argv.index('--')+1:]) if '--' in sys.argv else set(ASSETS)
for model in ASSETS:
    if model not in targets:continue
    render(model)
    if ASSETS[model]['joints']:render(model,'open')
if 'temperatureModuleV2' in targets:render('temperatureModuleV2',insert=True)
# Save all five assemblies at zero, in closed pose, in distinct collections.
for model,asset in ASSETS.items():
    collection=bpy.data.collections.new(model);SCENE.collection.children.link(collection)
    for obj in [asset['root']]+list(asset['root'].children_recursive):
        for col in list(obj.users_collection):col.objects.unlink(obj)
        collection.objects.link(obj);obj.hide_render=False
    for j in asset['joints']:
        n=asset['groups'][j['name']];n.location=j['pivot_mm'];n.rotation_euler=(0,0,0)
    for name,n in asset['groups'].items():
        if n.get('optional'):
            for o in n.children:o.hide_render=True
    # Independent model file includes only this collection and studio rig.
    individual=bpy.data.scenes.new(asset['label'])
    individual.unit_settings.system='METRIC';individual.unit_settings.scale_length=.001
    individual.collection.children.link(collection)
    center=Vector(manifest['modules'][model]['closed_bounds_mm']['min'])
    center+=Vector(manifest['modules'][model]['closed_bounds_mm']['max']);center*=.5
    for screen in bpy.data.screens:
        for area in screen.areas:
            if area.type=='VIEW_3D':
                area.spaces.active.clip_end=100000
                area.spaces.active.region_3d.view_location=center
                area.spaces.active.region_3d.view_distance=max(asset['dimensions_mm'])*2
    # Blender 5.2's partial scene-library writer can crash on shared collections.
    # A regular copy save keeps the active single-asset scene directly editable.
    bpy.context.window.scene=individual
    bpy.ops.wm.save_as_mainfile(filepath=str(OUT/model/'model.blend'),copy=True)
    bpy.context.window.scene=SCENE
    bpy.data.scenes.remove(individual)
# Arrange preview-only roots on a shelf; canonical local frames remain in each file/exports.
for i,(model,asset) in enumerate(ASSETS.items()):asset['root'].location.x=i*260
target=Vector((600,110,80));span=1350
camera.location=target+Vector((-.8,-1.4,.8))*span
aim(camera,target);camera.data.ortho_scale=span
for light,offset,energy in lights:
    light.location=target+Vector(offset)*span;light.data.energy=energy*span**2*.1;light.data.size=span*1.4;aim(light,target)
for screen in bpy.data.screens:
    for area in screen.areas:
        if area.type=='VIEW_3D':
            area.spaces.active.clip_end=100000
            area.spaces.active.region_3d.view_location=target
            area.spaces.active.region_3d.view_distance=1600
bpy.ops.wm.save_as_mainfile(filepath=str(ROOT/'blender/flex_modules.blend'))
print('FLEX_MODULES_BUILT '+str(OUT/'manifest.json'))
