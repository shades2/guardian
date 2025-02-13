import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MaterialModule } from './material.module';
import { DatetimePicker } from './components/datetime-picker/datetime-picker.component';
import { Dragonglass } from './components/dragonglass/dragonglass.component';
import { NgxMatDateFormats, NgxMatDatetimePickerModule, NGX_MAT_DATE_FORMATS } from '@angular-material-components/datetime-picker';
import { SelectMenuButton } from './components/select-menu/select-menu.component';
import { AsyncProgessComponent } from './components/async-progess/async-progess.component';
import { SwitchButton } from './components/switch-button/switch-button.component';
import { FormsModule } from '@angular/forms';

@NgModule({
    declarations: [
        DatetimePicker,
        Dragonglass,
        SelectMenuButton,
        AsyncProgessComponent,
        SwitchButton
    ],
    imports: [
        CommonModule,
        FormsModule,
        MaterialModule,
        NgxMatDatetimePickerModule
    ],
    exports: [
        DatetimePicker,
        Dragonglass,
        SelectMenuButton,
        SwitchButton,
        AsyncProgessComponent
    ]
})
export class CommonComponentsModule { }